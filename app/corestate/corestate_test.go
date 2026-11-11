package corestate

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/vfs"
)

// fakeCore is a fake core. Its first Mounts call waits for release and returns a starting mount.
// Every later call returns the mount as running. Its transfers are what active holds. Everything
// else is empty.
type fakeCore struct {
	calls   atomic.Int32
	entered chan struct{}
	release chan struct{}

	mu     sync.Mutex
	active []transfers.Transfer
}

func (c *fakeCore) Mounts(context.Context) ([]mounts.MountRow, error) {
	state := children.StatusRunning
	if c.calls.Add(1) == 1 {
		close(c.entered)
		<-c.release
		state = children.StatusStarting
	}
	return []mounts.MountRow{{ID: "m1", State: string(state)}}, nil
}

func (c *fakeCore) ActiveTransfers(context.Context) ([]transfers.Transfer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active, nil
}

func (*fakeCore) Remotes(context.Context) ([]engine.Remote, error)  { return nil, nil }
func (*fakeCore) Serves(context.Context) ([]serves.ServeRow, error) { return nil, nil }
func (*fakeCore) Vfs(context.Context) ([]vfs.VFS, error)            { return nil, nil }
func (*fakeCore) Tunnel(context.Context) (bool, error)              { return false, nil }
func (*fakeCore) ServeTypes(context.Context) ([]string, error)      { return nil, nil }
func (*fakeCore) EndedTransfers(context.Context, int) ([]transfers.Transfer, error) {
	return nil, nil
}

func newCore() *fakeCore {
	return &fakeCore{entered: make(chan struct{}), release: make(chan struct{})}
}

// ready returns a Store over c with the core running and nothing read yet.
func ready(c Reader) *Store {
	s := New(c, slog.New(slog.DiscardHandler))
	s.snap.Ready, s.run = true, 1
	return s
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("waited too long for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestRunningReadsInOrder: two changes in a row read the running items twice. The first read's
// older result never overwrites the second's.
func TestRunningReadsInOrder(t *testing.T) {
	c := newCore()
	s := ready(c)

	var wg sync.WaitGroup
	wg.Go(func() { s.refreshRunning(context.Background()) })
	<-c.entered
	wg.Go(func() { s.refreshRunning(context.Background()) })
	// the second read is requested before the first returns
	time.Sleep(50 * time.Millisecond)
	close(c.release)
	wg.Wait()

	got := s.Snapshot().Mounts
	if len(got) != 1 || got[0].State != string(children.StatusRunning) {
		t.Fatalf("mounts %v, want m1 running", got)
	}
}

func TestCoreDownForgetsTheCore(t *testing.T) {
	s := ready(newCore())
	s.snap.Mounts = []mounts.MountRow{{ID: "m0"}}
	s.snap.Live = map[string]bus.TransferProgress{"t1": {Pct: 5}}
	s.snap.Loaded = time.Now()
	var told atomic.Uint32
	s.Subscribe(func(p Part) { told.Store(uint32(p)) })

	s.CoreDown()
	eventually(t, "the subscriber", func() bool { return Part(told.Load()) == All })
	if snap := s.Snapshot(); snap.Ready || len(snap.Mounts) != 0 || len(snap.Live) != 0 || !snap.Loaded.IsZero() {
		t.Fatalf("after the core went: %+v", snap)
	}
}

// TestCoreDownDropsAReadInFlight: a read that began before the core stopped doesn't land, not
// even once the core is ready again, because it belongs to the run that ended.
func TestCoreDownDropsAReadInFlight(t *testing.T) {
	c := newCore()
	s := ready(c)

	var wg sync.WaitGroup
	wg.Go(func() { s.readRunning(context.Background()) })
	<-c.entered
	s.CoreDown()
	s.mu.Lock()
	s.snap.Ready, s.run = true, s.run+1 // the next run, without its own reads
	s.mu.Unlock()
	close(c.release)
	wg.Wait()

	if got := s.Snapshot().Mounts; len(got) != 0 {
		t.Fatalf("the old run's read landed: %v", got)
	}
}

// TestSubscriberSeesLatestSnapshot: a subscriber that is slow gets the changes made in the
// meantime in one later call, and that call's snapshot shows the latest state.
func TestSubscriberSeesLatestSnapshot(t *testing.T) {
	s := ready(newCore())
	first := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	var calls []Part
	var last []int
	s.Subscribe(func(p Part) {
		mu.Lock()
		calls = append(calls, p)
		n := len(calls)
		last = nil
		for _, tr := range s.Snapshot().Transfers {
			last = append(last, len(tr.Sources))
		}
		mu.Unlock()
		if n == 1 {
			close(first)
			<-release
		}
	})
	s.land(1, Remotes, func(*Snapshot) {})
	<-first
	// three changes while the subscriber is busy
	for n := 1; n <= 3; n++ {
		s.land(1, Transfers, func(d *Snapshot) {
			d.Transfers = []transfers.Transfer{{ID: "t1", Sources: make([]string, n)}}
		})
	}
	s.setProgress(map[string]bus.TransferProgress{"t1": {Pct: 7}})
	close(release)
	eventually(t, "the second call", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(calls) == 2
	})
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 || calls[0] != Remotes || calls[1] != Transfers|Progress {
		t.Fatalf("calls %v", calls)
	}
	if len(last) != 1 || last[0] != 3 {
		t.Fatalf("the last call saw %v, want the third transfers' read", last)
	}
	if p := s.Snapshot().Transfers[0].Live; p == nil || p.Pct != 7 {
		t.Fatalf("the progress was not merged: %v", p)
	}
}

// TestTransfersChangedPrunesLive: when a transfer ends, the next read of the transfers drops its
// progress and keeps the progress of the transfers that still run.
func TestTransfersChangedPrunesLive(t *testing.T) {
	c := newCore()
	s := ready(c)
	c.active = []transfers.Transfer{{ID: "t1", State: transfers.StateRunning}, {ID: "t2", State: transfers.StateQueued}}
	s.readTransfers(context.Background())
	s.Event(context.Background(), bus.Event{Name: bus.TransfersProgress, Data: bus.TransfersProgressData{
		Items: map[string]bus.TransferProgress{"t1": {Pct: 40}, "t2": {Pct: 10}},
	}})
	snap := s.Snapshot()
	if len(snap.Live) != 2 || snap.Transfers[1].State != transfers.StateRunning {
		t.Fatalf("after the progress: %+v", snap)
	}

	c.mu.Lock()
	c.active = c.active[1:] // t1 ended
	c.mu.Unlock()
	s.Event(context.Background(), bus.Event{Name: bus.TransfersChanged, Data: bus.TransfersChangedData{ID: "t1", State: "completed"}})
	eventually(t, "the read of the transfers", func() bool { return len(s.Snapshot().Live) == 1 })
	snap = s.Snapshot()
	if p, ok := snap.Live["t2"]; !ok || p.Pct != 10 || len(snap.Transfers) != 1 || snap.Transfers[0].Live == nil {
		t.Fatalf("after t1 ended: %+v", snap)
	}
}

func TestWithProgress(t *testing.T) {
	ts := []transfers.Transfer{
		{ID: "t1", State: transfers.StateRunning},
		{ID: "t2", State: transfers.StateQueued},
		{ID: "t3", State: transfers.StateQueued},
	}
	out, changed := withProgress(ts, map[string]bus.TransferProgress{
		"t1":   {Pct: 42},
		"t2":   {Pct: 1},
		"gone": {Pct: 99},
	})
	if !changed || out[0].Live.Pct != 42 || out[1].Live.Pct != 1 || out[1].State != transfers.StateRunning {
		t.Fatalf("changed %v: %v", changed, out)
	}
	if out[2].Live != nil || ts[0].Live != nil || ts[1].State != transfers.StateQueued {
		t.Error("the rows read were changed, or an unnamed one given numbers")
	}
	if _, changed := withProgress(ts, map[string]bus.TransferProgress{"gone": {}}); changed {
		t.Error("changed with no numbers for its rows")
	}
}

func TestSumProgress(t *testing.T) {
	eta := int64(9)
	if got := SumProgress([]*bus.TransferProgress{{Bytes: 1, TotalBytes: 4, Eta: &eta}, {}}); got.Pct != 25 || got.Left != 0 || got.Running != 2 {
		t.Errorf("an unknown ETA: %+v", got)
	}
	if got := SumProgress([]*bus.TransferProgress{{Bytes: 1, TotalBytes: 4, Eta: &eta}}); got.Left != 9*time.Second {
		t.Errorf("a known ETA: %+v", got)
	}
	if got := SumProgress([]*bus.TransferProgress{{}, nil}); got.Pct != -1 || got.Running != 1 {
		t.Errorf("no totals: %+v", got)
	}
}
