package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
)

// The APIs that need nothing from the boot answer before any core starts: the log, the app's
// info, and the catalog's backends and options. The others wait for the core, as the catalog's
// Values does, because it reads what rclone's init sets. Once the core fails, the waiting ones
// fail with Unavailable, and the early ones keep answering.
func TestEarlyAPIsAnswerBeforeTheBoot(t *testing.T) {
	dir := t.TempDir()
	l, err := logs.Open(logs.Options{Path: filepath.Join(dir, "rcui.log")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	l.Append(logs.Record{Message: "a line before the core"})

	apis := NewAPIs(APIOptions{Log: l, DataDir: dir})
	// Nothing sets the APIs, so a call that waited would fail with this deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if info, err := apis.App.Info(ctx); err != nil || info.DataDir != dir || info.PID != os.Getpid() || info.StartedAt == 0 {
		t.Errorf("Info: %+v %v", info, err)
	}
	// The log writes its lines on its own goroutine, so they reach the tail a moment later.
	testutil.Eventually(t, 2*time.Second, "the log's lines", func() bool {
		lines, err := apis.Logs.Tail(ctx, 10)
		return err == nil && len(lines) > 0
	})
	if cat, err := apis.Catalog.Get(ctx); err != nil || len(cat.Backends) == 0 {
		t.Errorf("Get: %d backends, %v", len(cat.Backends), err)
	}
	if b, err := apis.Catalog.Backend(ctx, "local", ""); err != nil || b.Backend.Name != "local" {
		t.Errorf("Backend: %+v %v", b.Backend.Name, err)
	}
	if p, err := apis.Catalog.ParseCommand(ctx, "rclone copy a: b: --transfers 8"); err != nil || len(p.Args) == 0 {
		t.Errorf("ParseCommand: %+v %v", p, err)
	}

	short, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	if _, err := apis.Catalog.Values(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Values before the boot: %v, want it to wait", err)
	}
	if _, err := apis.Links.Resolve(short, "https://example.com/a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Resolve before the boot: %v, want it to wait", err)
	}

	apis.fail(errors.New("the data folder is locked"))
	if _, err := apis.Catalog.Values(ctx); !unavailable(err) {
		t.Errorf("Values after a failed boot: %v", err)
	}
	if _, err := apis.Settings.Get(ctx); !unavailable(err) {
		t.Errorf("Settings after a failed boot: %v", err)
	}
	if info, err := apis.App.Info(ctx); err != nil || info.DataDir != dir {
		t.Errorf("Info after a failed boot: %+v %v", info, err)
	}
}

// unavailable reports whether err is the Unavailable error of an API whose core didn't start.
func unavailable(err error) bool {
	e := errs.Of(err)
	return e != nil && e.Code == errs.CodeUnavailable
}
