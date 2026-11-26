package schedules

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/bus/bustest"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs/rclonelog"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
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
	ctx   context.Context
	ts    *transfers.Service

	clockMu sync.Mutex
	now     time.Time
	waits   []time.Duration
	locked  bool

	goes sync.WaitGroup

	events *bustest.Recorder
}

func newFixture(t *testing.T, runner Runner, tweak ...func(*Options)) *fixture {
	t.Helper()
	d := testdb.Open(t)
	b := bus.New()
	f := &fixture{t: t, db: d, bus: b, notes: &notes{}, now: time.Date(2026, 11, 6, 12, 0, 30, 0, time.UTC)}
	f.events = bustest.Record(t, b)
	ctx, stop := context.WithCancel(context.Background())
	f.ctx = ctx
	if runner == nil {
		f.ts = transfers.New(transfers.Options{
			DB: d, Bus: b, Notifier: f.notes,
			Run: syncx.RunnerFunc(func(_ string, fn func(context.Context)) { go fn(context.Background()) }),
		})
		runner = f.ts
	}
	o := Options{
		DB: d, Bus: b, Transfers: runner, Notifier: f.notes, Location: time.UTC,
		Workdir: filepath.Join(t.TempDir(), "bisync"),
		Run:     syncx.RunnerFunc(func(_ string, fn func(context.Context)) { f.goes.Go(func() { fn(ctx) }) }),
		Now:     f.clock,
		After: func(d time.Duration) <-chan time.Time {
			f.clockMu.Lock()
			f.waits = append(f.waits, d)
			f.clockMu.Unlock()
			ch := make(chan time.Time, 1)
			ch <- time.Time{}
			return ch
		},
		Locked: func() bool {
			f.clockMu.Lock()
			defer f.clockMu.Unlock()
			return f.locked
		},
	}
	for _, tw := range tweak {
		tw(&o)
	}
	f.s = New(o)
	t.Cleanup(func() {
		f.s.Shutdown()
		stop()
		f.goes.Wait()
	})
	if f.ts != nil {
		t.Cleanup(func() { f.ts.Shutdown(context.Background(), false) })
	}
	return f
}

func (f *fixture) clock() time.Time {
	f.clockMu.Lock()
	defer f.clockMu.Unlock()
	return f.now
}

func (f *fixture) at(t time.Time) {
	f.clockMu.Lock()
	f.now = t
	f.clockMu.Unlock()
	f.s.mu.Lock()
	f.s.lastTick = t.Add(-time.Minute)
	f.s.mu.Unlock()
}

func (f *fixture) advance(d time.Duration) { f.at(f.clock().Add(d)) }

func (f *fixture) sleep(d time.Duration) {
	f.clockMu.Lock()
	f.now = f.now.Add(d)
	f.clockMu.Unlock()
}

func (f *fixture) boot() {
	f.s.boot(f.ctx)
	f.advance(f.s.o.Wait)
}

func (f *fixture) tick() {
	f.s.tick(f.ctx)
	f.goes.Wait()
}

func (f *fixture) published(name string) []bus.Event { return f.events.Named(name) }

func (f *fixture) toasts() []bus.NotifyOSData {
	f.notes.mu.Lock()
	defer f.notes.mu.Unlock()
	return append([]bus.NotifyOSData(nil), f.notes.toasts...)
}

func (f *fixture) save(in Input) *Schedule {
	f.t.Helper()
	sc, err := f.s.Save(context.Background(), in)
	if err != nil {
		f.t.Fatalf("saving %+v: %v", in, err)
	}
	return sc
}

func (f *fixture) get(id string) *Schedule {
	f.t.Helper()
	sc, err := f.s.Get(context.Background(), id)
	if err != nil {
		f.t.Fatalf("reading %s: %v", id, err)
	}
	return sc
}

func (f *fixture) lastDue(id string) time.Time {
	f.t.Helper()
	sc, err := f.s.read(context.Background(), id)
	if err != nil {
		f.t.Fatal(err)
	}
	return time.UnixMilli(sc.lastDue).UTC()
}

func copyArgs(sources []string, destination string) json.RawMessage {
	return rawArgs(map[string]any{"sources": sources, "destination": destination})
}

func rawArgs(args map[string]any) json.RawMessage {
	b, _ := json.Marshal(args)
	return b
}

func form(op operations.Operation, raw json.RawMessage) operations.Form {
	f, err := operations.DecodeForm(op, raw)
	if err != nil {
		panic(err)
	}
	return f
}

func argsOf(sc *Schedule) string {
	raw, err := sc.Form.MarshalArgs()
	if err != nil {
		panic(err)
	}
	return string(raw)
}

type notes struct {
	mu     sync.Mutex
	sent   []sent
	toasts []bus.NotifyOSData
}

type sent struct {
	event notifications.NotificationEvent
	job   notifications.Job
}

func (n *notes) Notify(_ context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	n.mu.Lock()
	defer n.mu.Unlock()
	j, _ := p.(notifications.Job)
	n.sent = append(n.sent, sent{event, j})
}

func (n *notes) Desktop(_ context.Context, e notifications.NotificationEvent, p notifications.Payload, d notifications.Desktop) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.toasts = append(n.toasts, d.NotifyOS(e, p))
}

func (n *notes) all() []sent {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]sent(nil), n.sent...)
}

type fakeRunner struct {
	mu       sync.Mutex
	starts   []transfers.Spec
	checks   int
	closed   map[string]bool
	refuse   []error
	checkErr error
}

func (r *fakeRunner) Start(_ context.Context, spec transfers.Spec) (transfers.Started, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.refuse) > 0 {
		err := r.refuse[0]
		r.refuse = r.refuse[1:]
		return transfers.Started{}, err
	}
	r.starts = append(r.starts, spec)
	n := len(r.starts)
	return transfers.Started{ID: fmt.Sprintf("t%d", n), Seq: int64(n)}, nil
}

func (r *fakeRunner) Stop(context.Context, string) error { return nil }

func (r *fakeRunner) Open(_ context.Context, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.closed[id], nil
}

func (r *fakeRunner) Check(context.Context, operations.Form) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.checks++
	return r.checkErr
}

func (r *fakeRunner) ToastText(_ context.Context, t transfers.Transfer) (string, string) {
	return "Copy failed", "body: " + t.Error
}

func (r *fakeRunner) FailureText(_ context.Context, t transfers.Transfer) i18n.Text {
	const reason = "couldn't connect SSH: connection refused"
	switch {
	case strings.HasPrefix(t.Error, "1 of "):
		return i18n.M("%s", reason)
	case strings.HasSuffix(t.Error, " operations failed"):
		return i18n.M("%s: %s", t.ErrorText(), reason)
	}
	return t.ErrorText()
}

func (r *fakeRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.starts)
}

func (r *fakeRunner) spec(i int) transfers.Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts[i]
}

func (r *fakeRunner) args(t *testing.T, i int) string {
	t.Helper()
	raw, err := r.spec(i).Form.MarshalArgs()
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func (r *fakeRunner) vanish(i int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed == nil {
		r.closed = map[string]bool{}
	}
	r.closed[fmt.Sprintf("t%d", i+1)] = true
}

func (r *fakeRunner) end(i int, state transfers.State, errText string, stats *transfers.Summary) {
	r.vanish(i)
	spec := r.spec(i)
	at := time.Now().UnixMilli()
	spec.Owner.Ended(transfers.Transfer{
		ID: fmt.Sprintf("t%d", i+1), Seq: int64(i + 1), State: state, Error: errText, Stats: stats, EndedAt: &at,
		Origin: spec.Origin, Operation: spec.Form.Operation,
	})
}

var changed = &transfers.Summary{Transfers: 1}
