package core

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/keychain"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/settings"
)

// Building the services starts no goroutine and writes nothing. In particular, children.json
// keeps the previous run's records, and stopping the services of a boot that failed before the
// start leaves it so, for the next start to clear what that run left.
func TestBuildStartsNothing(t *testing.T) {
	runDir, err := os.MkdirTemp("", "rc") // a socket's path must stay short
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runDir) })
	records := filepath.Join(runDir, "children.json")
	previous := []byte(`[{"id":"0badcafe","kind":"mount","pid":1}]`)
	if err := os.WriteFile(records, previous, 0o600); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	l, err := logs.Open(logs.Options{Path: filepath.Join(dataDir, "rcui.log")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })

	c := &Core{exe: executable(), dataDir: dataDir, runDir: runDir, socketDir: runDir, db: testdb.Open(t), bus: bus.New(), logs: l}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	t.Cleanup(c.cancel)
	// What openRclone creates, without rclone's init, which runs once per process.
	c.keychain = keychain.New(dataDir)
	c.settings = settings.New(c.db, c.bus)
	c.configs = config.New(config.Options{DB: c.db, Bus: c.bus, Secrets: c.keychain, InUse: c.configUsers})

	if err := c.build(); err != nil {
		t.Fatal(err)
	}
	if !c.built {
		t.Fatal("built isn't set")
	}
	// A loop that build started would still be running, and the wait would time out.
	if !syncx.Wait(context.Background(), &c.goes, 100*time.Millisecond) {
		t.Error("build started a goroutine on the core")
	}
	if got, err := os.ReadFile(records); err != nil || string(got) != string(previous) {
		t.Errorf("children.json after build: %q %v", got, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c.stopServices(ctx, false)
	if got, err := os.ReadFile(records); err != nil || string(got) != string(previous) {
		t.Errorf("children.json after a stop before the start: %q %v", got, err)
	}
}

// A subscriber gets what is published as soon as Subscribe returns, so a caller can subscribe and
// then cause an event without missing it. One that falls behind gets what it had, then Resync, and
// then what is published after that.
func TestSubscribeMissesNothing(t *testing.T) {
	c := &Core{bus: bus.New()}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.cancel()
	got := make(chan string)
	stop := c.Subscribe(func(ev bus.Event) {
		select {
		case got <- ev.Name:
		case <-c.ctx.Done():
		}
	})
	defer stop()
	next := func() string {
		t.Helper()
		select {
		case name := <-got:
			return name
		case <-time.After(10 * time.Second):
			t.Fatal("no event")
			return ""
		}
	}

	// Published at once, before the subscription's goroutine had any time to start.
	c.bus.Publish("first", nil)
	if name := next(); name != "first" {
		t.Fatalf("got %q, want the event published right after Subscribe", name)
	}

	// Nothing reads got, so the subscriber stops taking events and the bus drops it.
	for range 1000 {
		c.bus.Publish("flood", nil)
	}
	name := next()
	for name == "flood" {
		name = next()
	}
	if name != bus.Resync {
		t.Fatalf("got %q after falling behind, want %q", name, bus.Resync)
	}
	c.bus.Publish("after", nil)
	if name := next(); name != "after" {
		t.Errorf("got %q after the resync, want the event published after it", name)
	}
}
