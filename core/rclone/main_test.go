package rclone

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	// main.go imports every backend for the binary. The tests need memory, local, and the
	// providers that core/catalog lists.
	_ "github.com/rclone/rclone/backend/all"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fs/rc/jobs"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// Every test shares one Init, as the app does.
var (
	dataDir       string
	configPath    string // the active config file Init opened: [mem] type = memory
	store         *Store
	operatorHTTP  string // HTTP_PROXY before Init
	operatorHas   bool
	testProxy     = Proxy{URL: "http://127.0.0.1:9", IgnoredHosts: []string{"localhost", "10.0.0.0/8"}}
	errFromRclone = errors.New("the exact text rclone gave")
)

func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	dir, err := os.MkdirTemp("", "rcui-rclone-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if dataDir, err = filepath.EvalSymlinks(dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Don't touch the user's own files. rclone's default config file is
	// dataDir/rclone/rclone.conf.
	testutil.Home(dataDir)
	configPath = filepath.Join(dataDir, "rclone.conf")
	if err := os.WriteFile(configPath, []byte("[mem]\ntype = memory\n\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	registerTestCalls()
	operatorHTTP, operatorHas = os.LookupEnv("HTTP_PROXY")
	store, err = Init(context.Background(), InitOptions{
		ConfigPath: configPath,
		CacheDir:   filepath.Join(dataDir, "cache"),
		Proxy:      testProxy,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "init:", err)
		return 1
	}
	return m.Run()
}

// registerTestCalls adds rc functions the tests call through Call.
func registerTestCalls() {
	rc.Add(rc.Call{Path: "rcui-test/echo", Fn: func(ctx context.Context, in rc.Params) (rc.Params, error) {
		group, _ := accounting.StatsGroupFromContext(ctx)
		id, _ := jobs.GetJobID(ctx)
		accounting.Stats(ctx).Bytes(1) // creates the group
		return rc.Params{"group": group, "jobid": id, "dryRun": fs.GetConfig(ctx).DryRun, "in": in}, nil
	}})
	rc.Add(rc.Call{Path: "rcui-test/wait", Fn: func(ctx context.Context, in rc.Params) (rc.Params, error) {
		<-ctx.Done()
		return nil, context.Cause(ctx)
	}})
	rc.Add(rc.Call{Path: "rcui-test/fail", Fn: func(ctx context.Context, in rc.Params) (rc.Params, error) {
		return nil, errFromRclone
	}})
}
