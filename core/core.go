package core

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rclone/rclone/lib/atexit"

	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/favorites"
	"github.com/rclone/rclone-ui/core/files"
	"github.com/rclone/rclone-ui/core/internal/hostenv"
	"github.com/rclone/rclone-ui/core/keychain"
	"github.com/rclone/rclone-ui/core/launcher"
	"github.com/rclone/rclone-ui/core/linkresolve"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/logs/rclonelog"
	"github.com/rclone/rclone-ui/core/media"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/prefs"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/remotes"
	"github.com/rclone/rclone-ui/core/schedules"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/settings"
	"github.com/rclone/rclone-ui/core/telemetry"
	"github.com/rclone/rclone-ui/core/templates"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/tunnel"
	"github.com/rclone/rclone-ui/core/vfs"
	"github.com/rclone/rclone-ui/core/watchers"
)

const startWait = 10 * time.Second

const runningFile = "running"

type Options struct {
	// DataDir is the app's data folder. "" means the OS's default app data folder.
	DataDir string
	// RunDir is the folder for the children's sockets ($APP_RUN_DIR). It is useful when the temp
	// folder's path would make a socket path too long. "" means datadir.SocketDir's default.
	RunDir string
	// LogLevel is rclone's log level. "" means the level from the settings.
	LogLevel string
	// Log is the app's log, which the core and rclone write to. The ui opens and closes it.
	Log *logs.Log
	// HostEnv is the environment for the programs that the core starts. nil means this process's
	// environment.
	HostEnv []string
	// APIs are the APIs that the shell binds. Start connects them to their services once the
	// services start, and fails them when the core can't start. They are created with the same
	// data folder and log (APIOptions).
	APIs *APIs
}

type Core struct {
	opts      Options
	exe       string
	dataDir   string
	runDir    string
	socketDir string
	crashed   bool

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	stopping bool
	goes     sync.WaitGroup
	down     sync.Once
	backoff  children.Backoff

	release func()
	db      *db.DB
	bus     *bus.Bus
	logs    *logs.Log

	built bool

	keychain      *keychain.Keychain
	telemetry     *telemetry.Service
	settings      *settings.Service
	prefs         *prefs.Service
	templates     *templates.Service
	favorites     *favorites.Service
	launcher      *launcher.Service
	store         *rclone.Store
	configs       *config.Service
	remotes       *remotes.Service
	lister        *browse.Lister
	files         *files.Service
	media         *media.Signer
	notifications *notifications.Service
	children      *children.Supervisor
	mounts        *mounts.Service
	serves        *serves.Service
	vfs           *vfs.Service
	transfers     *transfers.Service
	watchers      *watchers.Service
	schedules     *schedules.Service
	links         *linkresolve.Resolver
	tunnel        *tunnel.Service

	libraryPath string
}

// Start boots the core and connects opts.APIs to their services. On an error, it stops whatever
// had started. The process-wide state that rclone set up remains, so a retry needs a new process.
func Start(opts Options) (*Core, error) {
	// This must run before anything registers with rclone's lib/atexit. The first registration
	// would otherwise install a signal handler that exits the process without going through the
	// UI's quit flow.
	atexit.IgnoreSignals()
	hostenv.Set(opts.HostEnv)
	c := &Core{opts: opts, exe: executable()}
	c.libraryPath = children.AppImageLibraryPath()
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if err := c.boot(c.ctx); err != nil {
		c.Shutdown(context.Background(), false)
		opts.APIs.fail(err)
		return nil, err
	}
	opts.APIs.set(c)
	return c, nil
}

func (c *Core) DataDir() string { return c.dataDir }

func (c *Core) Crashed() (crashed bool, interrupted int) {
	if !c.crashed {
		return false, 0
	}
	return true, c.transfers.Interrupted()
}

func executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
}

func (c *Core) boot(ctx context.Context) error {
	dir := c.opts.DataDir
	if dir == "" {
		d, err := datadir.Default()
		if err != nil {
			return err
		}
		dir = d
	}
	c.dataDir = dir
	release, err := datadir.Lock(ctx, dir, startWait)
	if err != nil {
		return err
	}
	c.release = release
	if c.runDir, err = datadir.RunDir(dir, ""); err != nil {
		return fmt.Errorf("run directory: %w", err)
	}
	if c.socketDir, err = datadir.SocketDir(dir, c.opts.RunDir); err != nil {
		return fmt.Errorf("the children's sockets' folder (set another with APP_RUN_DIR): %w", err)
	}
	c.crashed = markRunning(filepath.Join(c.runDir, runningFile))

	c.logs = c.opts.Log
	if c.logs == nil {
		if c.logs, err = logs.Open(logs.Options{Path: filepath.Join(dir, datadir.LogsDir, "rcui.log")}); err != nil {
			return err
		}
	}
	slog.SetDefault(slog.New(c.logs.Handler()))
	rclonelog.Install(c.logs)

	if c.db, err = db.Open(ctx, filepath.Join(dir, datadir.AppDB)); err != nil {
		return fmt.Errorf("database: %w", err)
	}
	c.Go("db.maintain", c.db.Maintain)

	c.bus = bus.New()
	return c.startServices(ctx)
}

func markRunning(path string) (crashed bool) {
	_, err := os.Stat(path)
	crashed = err == nil
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		logs.Logger(logs.CompApp, logs.SubStartup).Warn("writing the running file; a crash won't be noticed at the next start", "error", err)
	}
	return crashed
}
