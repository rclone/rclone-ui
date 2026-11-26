package watchers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs/rclonelog"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/runs"
	"github.com/rclone/rclone-ui/core/transfers"
)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.DiscardHandler))
	testutil.Main(m, func(dir string) error {
		rclonelog.Install(nil)
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, nil, 0o600); err != nil {
			return err
		}
		_, err := rclone.Init(context.Background(), rclone.InitOptions{
			ConfigPath: conf,
			CacheDir:   filepath.Join(dir, "cache"),
			LogLevel:   "NOTICE",
		})
		return err
	})
}

type fixture struct {
	t     *testing.T
	s     *Service
	db    *db.DB
	bus   *bus.Bus
	notes *notes
	ts    *transfers.Service
	run   func()

	evMu   sync.Mutex
	events []bus.Event
}

func newFixture(t *testing.T, runner runs.Transfers, tick time.Duration) *fixture {
	t.Helper()
	d := testdb.Open(t)
	b := bus.New()
	f := &fixture{t: t, db: d, bus: b, notes: &notes{}}
	sub := b.Subscribe()
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for ev := range sub.C {
			f.evMu.Lock()
			f.events = append(f.events, ev)
			f.evMu.Unlock()
		}
	}()
	ctx, stop := context.WithCancel(context.Background())
	var goes sync.WaitGroup
	if runner == nil {
		f.ts = transfers.New(transfers.Options{
			DB: d, Bus: b, Notifier: f.notes,
			Run: syncx.RunnerFunc(func(_ string, fn func(context.Context)) { go fn(context.Background()) }),
		})
		runner = f.ts
	}
	f.s = New(Options{
		DB: d, Bus: b, Transfers: runner, Notifier: f.notes, Tick: tick,
		Workdir: filepath.Join(t.TempDir(), "bisync"),
		Run:     syncx.RunnerFunc(func(_ string, fn func(context.Context)) { goes.Go(func() { fn(ctx) }) }),
	})
	t.Cleanup(func() {
		f.s.Shutdown()
		stop()
		goes.Wait()
		sub.Close()
		<-watched
	})
	f.run = func() { goes.Go(func() { f.s.Run(ctx) }) }
	if f.ts != nil {
		t.Cleanup(func() { f.ts.Shutdown(context.Background(), false) })
	}
	return f
}

func (f *fixture) published(name string) []bus.Event {
	f.evMu.Lock()
	defer f.evMu.Unlock()
	var out []bus.Event
	for _, ev := range f.events {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

func (f *fixture) save(in Input) *Watcher {
	f.t.Helper()
	w, err := f.s.Save(context.Background(), in)
	if err != nil {
		f.t.Fatalf("saving %+v: %v", in, err)
	}
	return w
}

func (f *fixture) get(id string) *Watcher {
	f.t.Helper()
	w, err := f.s.Get(context.Background(), id)
	if err != nil {
		f.t.Fatalf("reading %s: %v", id, err)
	}
	return w
}

type notes struct {
	mu     sync.Mutex
	got    []notifications.WatcherFailed
	others []notifications.NotificationEvent
	toasts []bus.NotifyOSData
}

func (n *notes) Notify(_ context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if event != notifications.NotificationEventWatcherFailed {
		n.others = append(n.others, event)
		return
	}
	n.got = append(n.got, p.(notifications.WatcherFailed))
}

func (n *notes) Desktop(_ context.Context, e notifications.NotificationEvent, p notifications.Payload, d notifications.Desktop) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.toasts = append(n.toasts, d.NotifyOS(e, p))
}

func (n *notes) desktop() []bus.NotifyOSData {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]bus.NotifyOSData(nil), n.toasts...)
}

func (n *notes) sentOthers() []notifications.NotificationEvent {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]notifications.NotificationEvent(nil), n.others...)
}

func (n *notes) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.got)
}

type fakeRunner struct {
	mu     sync.Mutex
	starts []transfers.Spec
	stops  []string
	closed map[string]bool
	refuse error
}

func (r *fakeRunner) Start(_ context.Context, spec transfers.Spec) (transfers.Started, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.refuse != nil {
		err := r.refuse
		r.refuse = nil
		return transfers.Started{}, err
	}
	r.starts = append(r.starts, spec)
	n := len(r.starts)
	return transfers.Started{ID: fmt.Sprintf("t%d", n), Seq: int64(n)}, nil
}

func (r *fakeRunner) Stop(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stops = append(r.stops, id)
	return nil
}

func (r *fakeRunner) Open(_ context.Context, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int
	if _, err := fmt.Sscanf(id, "t%d", &n); err != nil || n < 1 || n > len(r.starts) {
		return false, nil
	}
	return !r.closed[id], nil
}

func (r *fakeRunner) vanish(i int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed == nil {
		r.closed = map[string]bool{}
	}
	r.closed[fmt.Sprintf("t%d", i+1)] = true
}

func (r *fakeRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.starts)
}

func (r *fakeRunner) params(t *testing.T, i int) map[string]any {
	t.Helper()
	r.mu.Lock()
	spec := r.starts[i]
	r.mu.Unlock()
	if spec.Form.Bisync == nil || spec.Form.Bisync.Options.Outer == nil {
		t.Fatalf("not a bisync: %+v", spec.Form)
	}
	raw, err := json.Marshal(spec.Form.Bisync.Options.Outer)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func (r *fakeRunner) end(i int, state transfers.State, errText string, stats *transfers.Summary) {
	r.vanish(i)
	r.mu.Lock()
	spec := r.starts[i]
	r.mu.Unlock()
	at := time.Now().UnixMilli()
	spec.Owner.Ended(transfers.Transfer{
		ID: fmt.Sprintf("t%d", i+1), State: state, Error: errText, Stats: stats, EndedAt: &at,
		Origin: spec.Origin,
	})
}
