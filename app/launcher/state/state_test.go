package state

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/vfs"
)

// fakeCore is a fake core with one running transfer and nothing else.
type fakeCore struct{}

func (fakeCore) ActiveTransfers(context.Context) ([]transfers.Transfer, error) {
	return []transfers.Transfer{{ID: "t1", State: transfers.StateRunning}}, nil
}
func (fakeCore) Remotes(context.Context) ([]engine.Remote, error)  { return nil, nil }
func (fakeCore) Mounts(context.Context) ([]mounts.MountRow, error) { return nil, nil }
func (fakeCore) Serves(context.Context) ([]serves.ServeRow, error) { return nil, nil }
func (fakeCore) Vfs(context.Context) ([]vfs.VFS, error)            { return nil, nil }
func (fakeCore) Tunnel(context.Context) (bool, error)              { return false, nil }
func (fakeCore) ServeTypes(context.Context) ([]string, error)      { return nil, nil }
func (fakeCore) EndedTransfers(context.Context, int) ([]transfers.Transfer, error) {
	return nil, nil
}
func (fakeCore) List(context.Context, string, func([]engine.Entry)) error { return nil }
func (fakeCore) Services() engine.Services                                { return engine.Services{Vfs: noVfs{}} }

type noVfs struct{}

func (noVfs) Forget(context.Context, string) error { return nil }

// eventually fails the test unless ok becomes true within ten seconds.
func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("waited too long for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestServicesOnlyWhileReady: while the core isn't running, no core action and no folder listing
// is available.
func TestServicesOnlyWhileReady(t *testing.T) {
	store := corestate.New(fakeCore{}, slog.New(slog.DiscardHandler))
	h := New(store, fakeCore{})
	if s := h.Services(); s.Vfs != nil || h.Data().List != nil {
		t.Fatal("the services of a core that isn't running")
	}
	store.CoreReady(context.Background())
	if s := h.Services(); s.Vfs == nil || h.Data().List == nil {
		t.Fatal("no services for a running core")
	}
	store.CoreDown()
	if s := h.Services(); s.Vfs != nil || h.Data().List != nil {
		t.Fatal("the services of a core that went")
	}
}

// progressHandled subscribes to store after the launcher's state. Each change goes to the
// subscribers in turn, so when this subscriber hears of progress, the state has handled that
// progress and every change before it. The function it returns waits until this subscriber has
// heard of progress while the transfer was at pct.
func progressHandled(t *testing.T, store *corestate.Store) (wait func(pct int)) {
	var heard atomic.Int64
	heard.Store(math.MinInt64)
	store.Subscribe(func(p corestate.Part) {
		if p&corestate.Progress != 0 {
			heard.Store(int64(store.Snapshot().Live["t1"].Pct))
		}
	})
	return func(pct int) {
		t.Helper()
		eventually(t, fmt.Sprintf("the progress at %d%%", pct), func() bool { return heard.Load() == int64(pct) })
	}
}

// TestProgressIsToldOnceASecond: progress that arrives faster than progressEvery is reported once,
// after that time has passed. Progress that nobody follows still lands, but isn't reported.
func TestProgressIsToldOnceASecond(t *testing.T) {
	store := corestate.New(fakeCore{}, slog.New(slog.DiscardHandler))
	h := New(store, fakeCore{})
	var told atomic.Int32
	var mu sync.Mutex
	var toldAt time.Time
	h.OnChange(func() {
		mu.Lock()
		toldAt = time.Now()
		mu.Unlock()
		told.Add(1)
	})
	handled := progressHandled(t, store)
	progress := func(pct int) {
		store.Event(context.Background(), bus.Event{Name: bus.TransfersProgress, Data: bus.TransfersProgressData{
			Items: map[string]bus.TransferProgress{"t1": {Pct: pct}},
		}})
	}
	store.CoreReady(context.Background())
	eventually(t, "the first read", func() bool { return !store.Snapshot().Loaded.IsZero() })
	// The reads' own reports come before this progress, which isn't reported because nobody
	// follows it yet.
	progress(-1)
	handled(-1)
	h.FollowProgress(true)
	base := told.Load()

	sent := time.Now()
	progress(0)
	handled(0)
	if got := told.Load() - base; got != 1 {
		t.Fatalf("the first report: told %d times", got)
	}
	for pct := range 5 {
		progress(pct)
	}
	handled(4)
	if got := told.Load() - base; got != 1 {
		t.Fatalf("at once: told %d times", got)
	}
	eventually(t, "the second report", func() bool { return told.Load()-base >= 2 })
	if got := told.Load() - base; got != 2 {
		t.Fatalf("after a second: told %d times", got)
	}
	mu.Lock()
	after := toldAt.Sub(sent)
	mu.Unlock()
	if after < progressEvery {
		t.Errorf("the second report came %v after the first progress, want at least %v", after, progressEvery)
	}
	if got := h.Data().Transfers[0].Live.Pct; got != 4 {
		t.Errorf("the last numbers: %d%%", got)
	}
	h.FollowProgress(false)
	progress(50)
	eventually(t, "the numbers", func() bool { return h.Data().Transfers[0].Live.Pct == 50 })
	time.Sleep(progressEvery + 200*time.Millisecond)
	if got := told.Load() - base; got != 2 {
		t.Errorf("numbers nobody follows were reported: told %d times", got)
	}
}
