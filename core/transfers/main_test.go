package transfers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	// http: a remote that a test serves itself, to hold a transfer or a start's plan in the middle
	// of a request.
	_ "github.com/rclone/rclone/backend/http"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// TestMain initialises rclone once for the package, over an empty config: the tests use local
// folders and the memory backend.
func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.DiscardHandler))
	testutil.Main(m, func(dir string) error {
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, nil, 0o600); err != nil {
			return err
		}
		_, err := rclone.Init(context.Background(), rclone.InitOptions{
			ConfigPath: conf,
			CacheDir:   filepath.Join(dir, "cache"),
			LogLevel:   "CRITICAL",
		})
		return err
	})
}

// fixture is a Service over a fresh app.db. Its loops run until the test ends, after a shutdown
// that stops whatever is still running.
type fixture struct {
	t     *testing.T
	s     *Service
	db    *db.DB
	bus   *bus.Bus
	notes *notes
	// ctx is a start's context.
	ctx context.Context

	evMu   sync.Mutex
	events []bus.Event

	saidMu sync.Mutex
	said   map[string]chan struct{} // closed once the transfer's end was reported in full
}

func newFixture(t *testing.T, tweak ...func(*Options)) *fixture {
	t.Helper()
	d := testdb.Open(t)
	b := bus.New()
	f := &fixture{
		t: t, db: d, bus: b, notes: &notes{bus: b}, ctx: context.Background(),
	}
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
	run, stop := context.WithCancel(context.Background())
	var loops sync.WaitGroup
	t.Cleanup(func() {
		stop()
		loops.Wait()
		sub.Close()
		<-watched
	})
	o := Options{
		DB: d, Bus: b, Notifier: f.notes,
		Run: syncx.RunnerFunc(func(_ string, fn func(context.Context)) { loops.Go(func() { fn(run) }) }),
	}
	for _, tw := range tweak {
		tw(&o)
	}
	f.s = New(o)
	// The end callbacks run before the notifications are sent, so a test that checks them waits
	// for the whole report instead.
	f.s.reported = func(id string) {
		ch := f.saidOf(id)
		f.saidMu.Lock()
		defer f.saidMu.Unlock()
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	t.Cleanup(func() { f.s.Shutdown(context.Background(), false) })
	return f
}

func (f *fixture) saidOf(id string) chan struct{} {
	f.saidMu.Lock()
	defer f.saidMu.Unlock()
	if f.said == nil {
		f.said = map[string]chan struct{}{}
	}
	ch := f.said[id]
	if ch == nil {
		ch = make(chan struct{})
		f.said[id] = ch
	}
	return ch
}

// published returns every event with that name so far.
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

// settled waits for the end handlers, then for the events they published to be recorded. An
// event that an end didn't publish by then will never be published.
func (f *fixture) settled() {
	f.t.Helper()
	f.s.ends.Wait()
	n := len(f.published("test.settled"))
	f.bus.Publish("test.settled", nil)
	testutil.Eventually(f.t, 5*time.Second, "the events recorded", func() bool { return len(f.published("test.settled")) > n })
}

// toasts returns the desktop notifications (notify.os) published so far.
func (f *fixture) toasts() []bus.NotifyOSData {
	var out []bus.NotifyOSData
	for _, ev := range f.published(bus.NotifyOS) {
		out = append(out, ev.Data.(bus.NotifyOSData))
	}
	return out
}

// waitEnded blocks until the transfer has ended (or ctx ends) and returns it as it ended.
func waitEnded(ctx context.Context, s *Service, id string) (Transfer, error) {
	for {
		s.mu.Lock()
		rn := s.running[id]
		s.mu.Unlock()
		t, err := s.get(ctx, id)
		if err != nil || t.EndedAt != nil {
			return t, err
		}
		var ended <-chan struct{}
		if rn != nil {
			ended = rn.ended
		}
		select {
		case <-ended:
		case <-time.After(tickEvery):
		case <-ctx.Done():
			return t, ctx.Err()
		}
	}
}

// wait waits for a transfer's end to be written and reported, for 30 s at most.
func (f *fixture) wait(id string) Transfer {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t, err := waitEnded(ctx, f.s, id)
	if err != nil {
		f.t.Fatalf("waiting for %s: %v", id, err)
	}
	select {
	case <-f.saidOf(id):
	case <-ctx.Done():
		f.t.Fatalf("the end of %s was not said", id)
	}
	// transfers.changed reports the end after the end callbacks run, and the subscription
	// records it a moment later.
	for !f.endPublished(id) {
		select {
		case <-ctx.Done():
			f.t.Fatalf("transfers.changed never said the end of %s", id)
		case <-time.After(5 * time.Millisecond):
		}
	}
	return t
}

// endPublished reports whether a transfers.changed event for the end of id has been recorded.
func (f *fixture) endPublished(id string) bool {
	for _, ev := range f.published(bus.TransfersChanged) {
		if d := ev.Data.(bus.TransfersChangedData); d.ID == id && d.State != "queued" && d.State != "running" {
			return true
		}
	}
	return false
}

// memory returns a fresh folder on the memory backend. A copy to it is never a server-side clone
// (a local to local copy is one on macOS), so a bandwidth limit applies.
func memory() string {
	return fmt.Sprintf(":memory:t%d", time.Now().UnixNano())
}

func (f *fixture) get(id string) Transfer {
	f.t.Helper()
	t, err := f.s.get(context.Background(), id)
	if err != nil {
		f.t.Fatalf("reading %s: %v", id, err)
	}
	return t
}

// exec runs one statement on the writer.
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.db.W.ExecContext(context.Background(), q, args...); err != nil {
		f.t.Fatalf("%s: %v", q, err)
	}
}

// seed inserts a ledger row directly. set overrides columns of the default row, which is an
// ended copy.
func (f *fixture) seed(id string, created int64, set map[string]any) {
	f.t.Helper()
	cols := map[string]any{
		"id": id, "seq": created, "created_ms": created, "ended_ms": created + 10,
		"state": "completed", "operation": "copy", "sources": `["/a"]`, "origin_kind": "page",
		"request": `{"v":1,"steps":[{"op":"delete","src":"/a"}]}`, "stats_group": groupOf(id),
	}
	maps.Copy(cols, set)
	var names, marks []string
	var args []any
	for k, v := range cols {
		names = append(names, k)
		marks = append(marks, "?")
		args = append(args, v)
	}
	f.exec(`INSERT INTO transfers (`+strings.Join(names, ", ")+`) VALUES (`+strings.Join(marks, ", ")+`)`, args...)
}

// page is the origin of a transfer that an operation page started.
var page = Origin{Kind: OriginPage}

// notes records what the service notified.
type notes struct {
	bus *bus.Bus
	mu  sync.Mutex
	got []note
}

type note struct {
	event notifications.NotificationEvent
	job   notifications.Job
}

func (n *notes) Notify(_ context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	n.mu.Lock()
	defer n.mu.Unlock()
	j, _ := p.(notifications.Job)
	n.got = append(n.got, note{event, j})
}

// Desktop shows a desktop notification as the notification service does once the UI has
// subscribed: on the bus.
func (n *notes) Desktop(_ context.Context, e notifications.NotificationEvent, p notifications.Payload, d notifications.Desktop) {
	n.bus.Publish(bus.NotifyOS, d.NotifyOS(e, p))
}

func (n *notes) events(seq int64) []notifications.NotificationEvent {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []notifications.NotificationEvent
	for _, g := range n.got {
		if g.job.JobID == seq {
			out = append(out, g.event)
		}
	}
	return out
}

// groups returns every stats group that rclone holds.
func groups(t *testing.T) []string {
	t.Helper()
	out, err := rc.Calls.Get("core/group-list").Fn(context.Background(), rc.Params{})
	if err != nil {
		t.Fatal(err)
	}
	gs, _ := out["groups"].([]string)
	return gs
}

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("x", size)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// formOf returns the form of operation with args, which are its arguments or their JSON. It goes
// through the JSON that the args column stores, so a form that DecodeForm refuses fails the test.
func formOf(t *testing.T, operation operations.Operation, args any) operations.Form {
	t.Helper()
	raw, ok := args.(json.RawMessage)
	if !ok {
		raw = mustJSON(t, args)
	}
	f, err := operations.DecodeForm(operation, raw)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// groupsOf returns option groups as a page sends them, from pairs of name and JSON.
func groupsOf(kv ...string) operations.Groups {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%q:%s", kv[i], kv[i+1])
	}
	b.WriteByte('}')
	var g operations.Groups
	if err := json.Unmarshal([]byte(b.String()), &g); err != nil {
		panic(fmt.Sprintf("groups %s: %v", b.String(), err))
	}
	return g
}

// planOf returns a plan with these steps, like the ones that a retry or a resume starts.
func planOf(steps ...operations.Step) *operations.Plan {
	return &operations.Plan{V: operations.PlanVersion, Steps: steps}
}
