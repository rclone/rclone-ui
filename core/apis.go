package core

import (
	"context"

	"github.com/rclone/rclone-ui/core/app"
	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/favorites"
	"github.com/rclone/rclone-ui/core/files"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/launcher"
	"github.com/rclone/rclone-ui/core/linkresolve"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/media"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/prefs"
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

// Emit sends an event to the window that made the call ctx belongs to. When ctx doesn't belong
// to a call, it sends the event to every window.
type Emit func(ctx context.Context, name string, data any)

// APIs are the APIs that the pages call, one per domain. The shell binds them before the core
// starts. A call that arrives early waits for its service, and fails with Unavailable when the
// core failed to start. The calls that need nothing from the boot answer at once: the log, the
// app's info, and the catalog's backends and options (all but its Values). The links wait for the
// boot like the rest, because their first request fixes the proxy for the whole process, and
// rclone's init sets it.
type APIs struct {
	Prefs         *prefs.API
	Settings      *settings.API
	Favorites     *favorites.API
	Templates     *templates.API
	Launcher      *launcher.API
	Logs          *logs.API
	Vfs           *vfs.API
	Media         *media.API
	Files         *files.API
	Catalog       *catalog.API
	Config        *config.API
	Remotes       *remotes.API
	Mounts        *mounts.API
	Serves        *serves.API
	Tunnel        *tunnel.API
	Notifications *notifications.API
	Browse        *browse.API
	Transfers     *transfers.API
	Watchers      *watchers.API
	Schedules     *schedules.API
	Links         *linkresolve.API
	Telemetry     *telemetry.API
	App           *app.API

	telemetry *late.Value[*telemetry.Service]
	lister    *late.Value[*browse.Lister]
	transfers *late.Value[*transfers.Service]
	core      *late.Value[*Core]
	sets      []func(*Core)
	fails     []func(error)
}

// bind returns a value that an API waits for. Once the core has started, get reads the value
// from it.
func bind[T any](a *APIs, get func(*Core) T) *late.Value[T] {
	v := late.New[T]()
	a.sets = append(a.sets, func(c *Core) { v.Set(get(c)) })
	a.fails = append(a.fails, v.Fail)
	return v
}

type APIOptions struct {
	Emit Emit
	// Log is the app's log, which the core is given too (Options.Log). The Logs API reads it at
	// once. nil means the log that the core opens, once the core has started.
	Log *logs.Log
	// DataDir is the app's data folder, as the core is given it (Options.DataDir). "" means the
	// OS's default.
	DataDir string
}

func NewAPIs(o APIOptions) *APIs {
	a := &APIs{}
	dir := o.DataDir
	if dir == "" {
		// When the default can't be found, the core can't start either, and says why.
		dir, _ = datadir.Default()
	}
	log := late.Of(o.Log)
	if o.Log == nil {
		log = bind(a, func(c *Core) *logs.Log { return c.logs })
	}
	a.Prefs = prefs.NewAPI(bind(a, func(c *Core) *prefs.Service { return c.prefs }))
	a.Settings = settings.NewAPI(bind(a, func(c *Core) *settings.Service { return c.settings }))
	a.Favorites = favorites.NewAPI(bind(a, func(c *Core) *favorites.Service { return c.favorites }))
	a.Templates = templates.NewAPI(bind(a, func(c *Core) *templates.Service { return c.templates }))
	a.Launcher = launcher.NewAPI(bind(a, func(c *Core) *launcher.Service { return c.launcher }))
	a.Logs = logs.NewAPI(log)
	a.Vfs = vfs.NewAPI(bind(a, func(c *Core) *vfs.Service { return c.vfs }))
	a.Media = media.NewAPI(bind(a, func(c *Core) *media.Signer { return c.media }))
	a.Files = files.NewAPI(bind(a, func(c *Core) *files.Service { return c.files }))
	a.Catalog = catalog.NewAPI(catalog.New(executable()), bind(a, func(*Core) struct{} { return struct{}{} }))
	a.Config = config.NewAPI(bind(a, func(c *Core) *config.Service { return c.configs }))
	a.Remotes = remotes.NewAPI(bind(a, func(c *Core) *remotes.Service { return c.remotes }))
	a.Mounts = mounts.NewAPI(bind(a, func(c *Core) *mounts.Service { return c.mounts }))
	a.Serves = serves.NewAPI(bind(a, func(c *Core) *serves.Service { return c.serves }))
	a.Tunnel = tunnel.NewAPI(bind(a, func(c *Core) *tunnel.Service { return c.tunnel }))
	a.Notifications = notifications.NewAPI(bind(a, func(c *Core) *notifications.Service { return c.notifications }))
	a.lister = bind(a, func(c *Core) *browse.Lister { return c.lister })
	a.Browse = browse.NewAPI(a.lister, o.Emit)
	a.transfers = bind(a, func(c *Core) *transfers.Service { return c.transfers })
	a.Transfers = transfers.NewAPI(a.transfers, bind(a, func(c *Core) transfers.Templates { return c.templates }))
	a.Watchers = watchers.NewAPI(bind(a, func(c *Core) *watchers.Service { return c.watchers }))
	a.Schedules = schedules.NewAPI(bind(a, func(c *Core) *schedules.Service { return c.schedules }))
	a.Links = linkresolve.NewAPI(bind(a, func(c *Core) *linkresolve.Resolver { return c.links }))
	a.telemetry = bind(a, func(c *Core) *telemetry.Service { return c.telemetry })
	a.Telemetry = telemetry.NewAPI(a.telemetry)
	a.App = app.NewAPI(dir)
	a.core = bind(a, func(c *Core) *Core { return c })
	return a
}

// ListFolder lists a folder for the shell's launcher. It calls page with the rows as they
// arrive.
func (a *APIs) ListFolder(ctx context.Context, path string, page func([]browse.Row)) error {
	l, err := a.lister.Get(ctx)
	if err != nil {
		return err
	}
	// The launcher shows no dates, so it never waits for slow ones.
	_, _, err = browse.ListFolder(ctx, l, path, false, false, page)
	return err
}

// ListRows lists a folder for the agents' server, and returns all the rows together. It asks
// rclone rather than the cache, because the agent may have just changed the folder by other
// means. It returns at most browse.ListMax rows, and whether the listing stopped there. Like
// ListFolder, it never waits for slow dates.
func (a *APIs) ListRows(ctx context.Context, path string) ([]browse.Row, bool, error) {
	l, err := a.lister.Get(ctx)
	if err != nil {
		return nil, false, err
	}
	var rows []browse.Row
	_, capped, err := browse.ListFolder(ctx, l, path, true, false, func(page []browse.Row) { rows = append(rows, page...) })
	if err != nil {
		return nil, false, err
	}
	return rows, capped, nil
}

// SearchRows finds the entries under a folder whose names contain q, for the agents' server
// (browse.SearchFolder), and returns all the rows together, without the slow dates. It returns at
// most limit rows, and whether the search stopped there. When the walk stops early, it returns the
// rows found so far along with the error: ctx's error, or browse.ErrWalkMax at
// browse.SearchWalkMax entries.
func (a *APIs) SearchRows(ctx context.Context, path, q string, limit int) ([]browse.Row, bool, error) {
	if _, err := a.core.Get(ctx); err != nil {
		return nil, false, err
	}
	var rows []browse.Row
	capped, err := browse.SearchFolder(ctx, path, q, limit, false, func(page []browse.Row) { rows = append(rows, page...) })
	return rows, capped, err
}

// CountFolder counts the files and their bytes below a folder, for the agents' server
// (browse.CountFolder). When ctx ends partway, it returns the counts so far with ctx's error.
func (a *APIs) CountFolder(ctx context.Context, path string) (browse.Size, error) {
	return late.Call(ctx, a.core, func(*Core) (browse.Size, error) { return browse.CountFolder(ctx, path) })
}

// ReadFile returns the first limit bytes of a file, for the agents' server (media.Read).
func (a *APIs) ReadFile(ctx context.Context, path string, limit int64) (media.Start, error) {
	return late.Call(ctx, a.core, func(*Core) (media.Start, error) { return media.Read(ctx, path, limit) })
}

// StartCleanup starts the launcher's cleanup of a remote's trash and old file versions as a
// transfer, which History follows. transfers.API.Start doesn't start a cleanup, because no page
// does.
func (a *APIs) StartCleanup(ctx context.Context, remote string) (transfers.Started, error) {
	return late.Call(ctx, a.transfers, func(s *transfers.Service) (transfers.Started, error) {
		return s.Start(ctx, transfers.Spec{
			Form: operations.CleanupArgs{Remote: remote}.Form(), Origin: transfers.Origin{Kind: transfers.OriginPage},
		})
	})
}

// StopAll is the launcher's Stop Everything (see Core.StopAll). No page calls it.
func (a *APIs) StopAll(ctx context.Context) (StopSummary, error) {
	return late.Call(ctx, a.core, func(c *Core) (StopSummary, error) { return c.StopAll(ctx) })
}

// set gives each API its service, once every service has started.
func (a *APIs) set(c *Core) {
	if a == nil {
		return
	}
	for _, set := range a.sets {
		set(c)
	}
}

// fail makes every waiting API call, and every later one, fail with Unavailable.
func (a *APIs) fail(err error) {
	if a == nil {
		return
	}
	for _, fail := range a.fails {
		fail(err)
	}
}

// Screen records that a window opened, by its fixed name, in the usage data that the user shares
// (core/telemetry). The shell calls it. It never waits, and does nothing before the core is up.
func (a *APIs) Screen(window string) {
	if s, ok := a.telemetry.Ready(); ok {
		s.Screen(window)
	}
}

// Panic reports a panic that was recovered and logged, as a crash report, when the user shares
// them. source is the part of the app that logged it. The shell calls it for every such line of
// the log (telemetry.TapPanics). It never waits, and does nothing before the core is up.
func (a *APIs) Panic(source, value, stack string) {
	if s, ok := a.telemetry.Ready(); ok {
		s.Panic(source, value, []byte(stack))
	}
}
