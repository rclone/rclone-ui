package core

// This test binary is also the serve child that TestStartServeShutdown starts. When it runs as a
// rclone child (marked by childenv), it runs rclone's command line, as main.go does.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/serve/http"
	rcloneconfig "github.com/rclone/rclone/fs/config"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/schedules"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/settings"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/watchers"
)

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(childenv.Env); ok {
		childenv.Adopt(children.OwnMount)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	testutil.Main(m, nil)
}

// The core starts in this process on rclone's default config file, which is encrypted and whose
// password it doesn't know. RCLONE_CONFIG names another file, which the core ignores. An unlock
// opens the file: the remotes get their rows and remotes.changed is sent. The core answers API
// calls and runs a serve as a child, with the one config file. On Shutdown it stops the child and
// removes the running file, so the next start isn't mistaken for one after a crash.
func TestStartUnlockServeShutdown(t *testing.T) {
	dir := t.TempDir()
	runDir, err := os.MkdirTemp("", "rc") // a socket's path must stay short
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runDir) })
	folder := filepath.Join(dir, "files")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}

	conf := rcloneconfig.GetConfigPath() // testutil.Home's file
	enc, err := rclone.EncryptConfig([]byte("[box]\ntype = local\n"), "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	testutil.Must(t, os.MkdirAll(filepath.Dir(conf), 0o700))
	testutil.Must(t, os.WriteFile(conf, enc, 0o600))
	other := filepath.Join(dir, "other.conf")
	testutil.Must(t, os.WriteFile(other, []byte("[other]\ntype = local\n"), 0o600))
	t.Setenv("RCLONE_CONFIG", other)

	// A stand-in for PostHog keeps what the core sends, as text, to check at the end that it
	// holds nothing of the user's.
	var (
		sentMu sync.Mutex
		sent   []string
	)
	posthog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sentMu.Lock()
		sent = append(sent, string(body))
		sentMu.Unlock()
		_, _ = w.Write([]byte(`{"status":1}`))
	}))
	// It closes after the core has shut down (the cleanup below), which sends what is waiting.
	t.Cleanup(posthog.Close)
	type event struct {
		Event      string         `json:"event"`
		Properties map[string]any `json:"properties"`
	}
	// events returns what the stand-in has got so far: the events, and the text they came in.
	events := func() (out []event, text string) {
		t.Helper()
		sentMu.Lock()
		bodies := slices.Clone(sent)
		sentMu.Unlock()
		for _, body := range bodies {
			var batch struct {
				Batch []event `json:"batch"`
			}
			testutil.Must(t, json.Unmarshal([]byte(body), &batch))
			out = append(out, batch.Batch...)
		}
		return out, strings.Join(bodies, "\n")
	}
	t.Setenv("RCUI_TELEMETRY_KEY", "phc_test")
	t.Setenv("RCUI_TELEMETRY_HOST", posthog.URL)
	t.Setenv("DO_NOT_TRACK", "")

	apis := NewAPIs(APIOptions{Emit: func(context.Context, string, any) {}, DataDir: filepath.Join(dir, "data")})
	c, err := Start(Options{DataDir: filepath.Join(dir, "data"), RunDir: runDir, APIs: apis})
	if err != nil {
		t.Fatal(err)
	}
	// A test that fails halfway still stops its core, so the core's goroutines and its child
	// can't reach into the tests that run after it. Only the first Shutdown does anything.
	t.Cleanup(func() { c.Shutdown(context.Background(), false) })
	// hasSent waits until the stand-in has got n events named name. The core queues an event on a
	// goroutine of its own, some time after the test can see what the event is about. So the test
	// waits for each event where it is due, and nothing depends on which goroutine ran first.
	hasSent := func(name string, n int) {
		t.Helper()
		testutil.Eventually(t, 30*time.Second, fmt.Sprintf("%d %s sent", n, name), func() bool {
			c.telemetry.Flush()
			all, _ := events()
			got := 0
			for _, e := range all {
				if e.Event == name {
					got++
				}
			}
			return got >= n
		})
	}
	if crashed, _ := c.Crashed(); crashed {
		t.Error("a first start taken for one after a crash")
	}
	ctx := context.Background()
	if info, err := apis.App.Info(ctx); err != nil || info.PID != os.Getpid() {
		t.Fatalf("Info: %+v %v", info, err)
	}

	got, err := apis.Config.Get(ctx)
	if err != nil || got.Path != conf || got.Status != config.StatusNeedsPassword {
		t.Fatalf("the config at start: %+v %v", got, err)
	}
	changed := make(chan []string, 10)
	stop := c.Subscribe(func(ev bus.Event) {
		if d, ok := ev.Data.(bus.RemotesChangedData); ev.Name == bus.RemotesChanged && ok {
			changed <- d.Names
		}
	})
	defer stop()
	if got, err := apis.Config.Unlock(ctx, "s3cret", false); err != nil || got.Status != config.StatusOK {
		t.Fatalf("unlock: %+v %v", got, err)
	}
	select {
	case names := <-changed:
		if !slices.Contains(names, "box") {
			t.Errorf("remotes.changed names %v", names)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no remotes.changed after the unlock")
	}
	// Sharing starts off on Linux, and the core sends once it is on.
	on := true
	if _, err := apis.Settings.Update(ctx, settings.Patch{TelemetryEnabled: &on}); err != nil {
		t.Fatal(err)
	}
	hasSent("app_started", 1)

	// A copy from the "box" remote to a local folder, which is sent by its kind and its backends.
	started, err := apis.Transfers.Start(ctx,
		operations.CopyArgs{Sources: []string{"box:" + folder}, Destination: filepath.Join(dir, "copied")}.Form(),
		transfers.StartOptions{Origin: transfers.OriginCommander})
	testutil.Must(t, err)
	testutil.Eventually(t, 30*time.Second, "the copy to end", func() bool {
		d, err := apis.Transfers.Get(ctx, started.ID)
		return err == nil && d.Transfer.EndedAt != nil
	})
	hasSent("transfer_ended", 1)

	var rows []string
	testutil.Must(t, c.db.Read(ctx, func(tx *sql.Tx) error {
		r, err := tx.QueryContext(ctx, `SELECT remote FROM remote_fsinfo`)
		if err != nil {
			return err
		}
		rows, err = db.Collect(r, func(sc db.Scanner) (string, error) {
			var n string
			return n, sc.Scan(&n)
		})
		return err
	}))
	if !slices.Equal(rows, []string{"box"}) {
		t.Errorf("remote_fsinfo after the unlock: %v", rows)
	}

	// The watchers and schedules that keep running while the app is open, for the quit dialog.
	if k := c.KeepsRunning(ctx); k != (Kept{}) {
		t.Errorf("kept with none: %+v", k)
	}
	w, err := apis.Watchers.Save(ctx, watchers.Input{Name: "W", PathA: folder, PathB: filepath.Join(dir, "other")})
	testutil.Must(t, err)
	sc, err := apis.Schedules.Save(ctx, schedules.Input{Name: "S", When: "@daily",
		Form: operations.CopyArgs{Sources: []string{folder}, Destination: filepath.Join(dir, "copy")}.Form()})
	testutil.Must(t, err)
	if k := c.KeepsRunning(ctx); k != (Kept{Watchers: 1, Schedules: 1}) {
		t.Errorf("kept: %+v", k)
	}
	// A new watcher runs at once, and a pause lets that run finish. Wait for its end, so that its
	// bisync isn't still running when Busy is read below.
	testutil.Eventually(t, 30*time.Second, "the watcher's first run", func() bool {
		got, err := apis.Watchers.Get(ctx, w.ID)
		return err == nil && got.LastRunAt != nil
	})
	testutil.Must(t, apis.Watchers.Pause(ctx, w.ID))
	testutil.Must(t, apis.Schedules.Pause(ctx, sc.ID))
	if k := c.KeepsRunning(ctx); k != (Kept{}) {
		t.Errorf("kept with everything paused: %+v", k)
	}

	// The core sends a serve once it hears that the serve runs, and reads the serve from the list
	// then. So each serve is sent before the test stops it.
	served := 0
	serve := func() serves.Serve {
		t.Helper()
		v, err := c.serves.Start(ctx, operations.ServeArgs{Type: "http", Source: folder, Addr: "127.0.0.1:0"})
		if err != nil {
			t.Fatal(err)
		}
		testutil.Eventually(t, 30*time.Second, "the serve to run", func() bool {
			for _, s := range c.serves.List() {
				if s.ID == v.ID && s.State == children.StatusRunning {
					return true
				}
			}
			return false
		})
		served++
		hasSent("serve_started", served)
		return v
	}

	// Stop Everything stops what Busy lists, and leaves the paused watcher and schedule as they
	// are.
	serve()
	if b := c.Busy(ctx); len(b.Items) != 1 || b.Items[0].Kind != "serve" || b.Running != (Running{Serves: 1}) {
		t.Fatalf("busy %+v", b)
	}
	sum, err := c.StopAll(ctx)
	if err != nil || sum.Done().String() != "Stopped a serve." {
		t.Fatalf("stop all: %q, %v", sum.Done(), err)
	}
	if b := c.Busy(ctx); len(b.Items) != 0 {
		t.Fatalf("busy after stopping everything %+v", b)
	}
	if got, err := apis.Watchers.Get(ctx, w.ID); err != nil || !got.Paused {
		t.Errorf("the watcher after stopping everything: %+v, %v", got, err)
	}

	v := serve()
	pid := c.serves.List()[0].PID
	c.Shutdown(ctx, false)
	if alive(pid) {
		t.Errorf("the serve's child %d outlived the shutdown", pid)
	}
	if _, err := http.Get("http://" + v.Addr + "/"); err == nil {
		t.Error("still serving after the shutdown")
	}
	if _, err := os.Stat(filepath.Join(c.runDir, runningFile)); !os.IsNotExist(err) {
		t.Errorf("the running file: %v", err)
	}

	// The run is described by counts and types, each serve by its protocol and backend, and nothing
	// names the user's folders, files or remotes.
	sentEvents, all := events()
	count := map[string]int{}
	for _, e := range sentEvents {
		count[e.Event]++
		switch e.Event {
		case "app_started":
			if e.Properties["remotes"] != float64(1) || fmt.Sprint(e.Properties["backends"]) != "[local]" || e.Properties["app_version"] == nil {
				t.Errorf("app_started: %v", e.Properties)
			}
		case "transfer_ended":
			p := e.Properties
			if p["operation"] != "copy" || p["origin"] != "commander" || p["state"] != "completed" ||
				p["source_backend"] != "local" || p["destination_backend"] != "local" || p["files"] != float64(1) {
				t.Errorf("transfer_ended: %v", p)
			}
		case "serve_started":
			if e.Properties["protocol"] != "http" || e.Properties["backend"] != "local" {
				t.Errorf("serve_started: %v", e.Properties)
			}
		}
	}
	t.Logf("events sent: %v", count)
	if count["app_started"] != 1 || count["serve_started"] != 2 || count["transfer_ended"] != 1 {
		t.Errorf("events sent: %v", count)
	}
	for _, private := range []string{dir, folder, "a.txt", `"box"`, "s3cret", "other.conf"} {
		if strings.Contains(all, private) {
			t.Errorf("what was sent holds %q:\n%s", private, all)
		}
	}
}
