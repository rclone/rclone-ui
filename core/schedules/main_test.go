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

// TestMain initialises rclone once for the package, over an empty config. The tests use local
// folders. rclone's log goes through the app's handler, as in the app, so a bisync's log lines
// can be heard.
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

// fixture is a Service over a fresh app.db, with a clock that the test moves. Its scheduler
// doesn't run on its own: a test calls tick.
type fixture struct {
	t     *testing.T
	s     *Service
	db    *db.DB
	bus   *bus.Bus
	notes *notes
	ctx   context.Context
	// ts is the real transfer service, when the runs go to one.
	ts *transfers.Service

	clockMu sync.Mutex
	now     time.Time
	waits   []time.Duration // the waits asked of After
	locked  bool

	goes sync.WaitGroup

	events *bustest.Recorder
}

// newFixture returns a Service whose runs go to runner, at 2026-11-06 12:00:30 UTC. A nil runner
// is a real transfer service (f.ts), which tells the same notification targets.
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
		// Registered last, so that it runs first: the transfers stop before the schedules do.
		t.Cleanup(func() { f.ts.Shutdown(context.Background(), false) })
	}
	return f
}

func (f *fixture) clock() time.Time {
	f.clockMu.Lock()
	defer f.clockMu.Unlock()
	return f.now
}

// at sets the clock, as if the scheduler had ticked every minute until then.
func (f *fixture) at(t time.Time) {
	f.clockMu.Lock()
	f.now = t
	f.clockMu.Unlock()
	f.s.mu.Lock()
	f.s.lastTick = t.Add(-time.Minute)
	f.s.mu.Unlock()
}

// advance moves the clock on, as if the scheduler had ticked every minute meanwhile.
func (f *fixture) advance(d time.Duration) { f.at(f.clock().Add(d)) }

// sleep moves the clock on without a tick, as when the computer sleeps.
func (f *fixture) sleep(d time.Duration) {
	f.clockMu.Lock()
	f.now = f.now.Add(d)
	f.clockMu.Unlock()
}

// boot settles the last runs and starts the wait after a start, then lets it pass, as the
// scheduler does when it starts.
func (f *fixture) boot() {
	f.s.boot(f.ctx)
	f.advance(f.s.o.Wait)
}

// tick runs one tick and waits for the starts it began.
func (f *fixture) tick() {
	f.s.tick(f.ctx)
	f.goes.Wait()
}

// published returns the events with that name so far.
func (f *fixture) published(name string) []bus.Event { return f.events.Named(name) }

// toasts returns the desktop notifications so far.
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

// copyArgs returns the arguments of a Copy form, as they are stored.
func copyArgs(sources []string, destination string) json.RawMessage {
	return rawArgs(map[string]any{"sources": sources, "destination": destination})
}

// rawArgs returns a form's arguments as they are stored. A test's paths go through it, because
// the `\` of a Windows path starts an escape in JSON that is written by hand.
func rawArgs(args map[string]any) json.RawMessage {
	b, _ := json.Marshal(args)
	return b
}

// form returns the form of op with the arguments raw. It panics when they can't be read.
func form(op operations.Operation, raw json.RawMessage) operations.Form {
	f, err := operations.DecodeForm(op, raw)
	if err != nil {
		panic(err)
	}
	return f
}

// argsOf returns a schedule's arguments as they are stored.
func argsOf(sc *Schedule) string {
	raw, err := sc.Form.MarshalArgs()
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// notes records the notifications sent to the targets and to the desktop.
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

// Desktop records a desktop notification as the notification service would publish it. It records
// it at once, rather than through the bus, whose subscriber records events a moment later.
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

// fakeRunner records the starts, and ends a run when the test says so.
type fakeRunner struct {
	mu     sync.Mutex
	starts []transfers.Spec
	checks int
	closed map[string]bool
	// refuse holds errors for the next starts, which then record nothing.
	refuse []error
	// checkErr is Check's answer.
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

// FailureText adds a step's error to a count of failed steps, as transfers does.
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

// args returns the arguments of start i (from 0), as the args column stores them.
func (r *fakeRunner) args(t *testing.T, i int) string {
	t.Helper()
	raw, err := r.spec(i).Form.MarshalArgs()
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// vanish closes start i (from 0) without reporting its end.
func (r *fakeRunner) vanish(i int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed == nil {
		r.closed = map[string]bool{}
	}
	r.closed[fmt.Sprintf("t%d", i+1)] = true
}

// end ends start i (from 0) as its transfer would.
func (r *fakeRunner) end(i int, state transfers.State, errText string, stats *transfers.Summary) {
	r.vanish(i)
	spec := r.spec(i)
	at := time.Now().UnixMilli()
	spec.Owner.Ended(transfers.Transfer{
		ID: fmt.Sprintf("t%d", i+1), Seq: int64(i + 1), State: state, Error: errText, Stats: stats, EndedAt: &at,
		Origin: spec.Origin, Operation: spec.Form.Operation,
	})
}

// changed is a run's totals with one file copied.
var changed = &transfers.Summary{Transfers: 1}
