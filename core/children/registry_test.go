package children

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
)

// TestClip checks that a child's error is cut on a character boundary, whatever is at the cut,
// and made valid UTF-8, because the pages show it as is.
func TestClip(t *testing.T) {
	const n = 10
	for _, r := range []string{"é", "€", "😀"} {
		for pad := range utf8.UTFMax {
			s := strings.Repeat("x", pad) + strings.Repeat(r, n)
			got := clip(s, n)
			if !utf8.ValidString(got) || !strings.HasSuffix(got, "…") || len(got) > n+len("…") || !strings.HasPrefix(s, strings.TrimSuffix(got, "…")) {
				t.Errorf("clip(%q, %d) = %q", s, n, got)
			}
		}
	}
	for s, want := range map[string]string{
		"short":            "short",
		"exactly10!":       "exactly10!",
		"eleven chars":     "eleven cha…",
		"bad \xff byte":    "bad � byte",
		"\xe2\x82 cut":     "� cut",
		"0123456789\xffxx": "0123456789…",
	} {
		if got := clip(s, n); got != want {
			t.Errorf("clip(%q, %d) = %q, want %q", s, n, got, want)
		}
	}
}

var errGone = errors.New("not running any more")

// changes records the calls to a registry's hooks.
type changes struct {
	mu    sync.Mutex
	list  []change
	downs []bool // the again argument of each Down call, in order
	ups   int
	ch    chan struct{}
}

type change struct {
	id  string
	st  Status
	msg string
}

func (c *changes) publish(ch *Child[string], st Status, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	c.mu.Lock()
	c.list = append(c.list, change{ch.ID, st, msg})
	c.mu.Unlock()
	select {
	case c.ch <- struct{}{}:
	default:
	}
}

// wait returns the nth change of id to one of states. It fails the test after 30 s.
func (c *changes) wait(t *testing.T, id string, n int, states ...Status) change {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		c.mu.Lock()
		list := slices.Clone(c.list)
		c.mu.Unlock()
		seen := 0
		for _, x := range list {
			if x.id == id && slices.Contains(states, x.st) {
				if seen++; seen == n {
					return x
				}
			}
		}
		select {
		case <-c.ch:
		case <-deadline:
			t.Fatalf("no change %d of %s to %v; got %+v", n, id, states, list)
		}
	}
}

func newRegistry(t *testing.T, sup *Supervisor, tweak func(*RegistryOptions[string])) (*Registry[string], *changes) {
	t.Helper()
	ch := &changes{ch: make(chan struct{}, 1)}
	o := RegistryOptions[string]{
		Kind: KindServe, Component: logs.CompServes, Children: sup, NotFound: errGone,
		ReadyTimeout: 10 * time.Second, StopWait: 20 * time.Second,
		Backoff: Backoff{Min: 50 * time.Millisecond, Max: 100 * time.Millisecond, Reset: time.Hour},
		Publish: ch.publish, Configs: helperConfig{},
		Up: func(*Child[string]) {
			ch.mu.Lock()
			ch.ups++
			ch.mu.Unlock()
		},
		Down: func(_ *Child[string], _ error, again bool) {
			ch.mu.Lock()
			ch.downs = append(ch.downs, again)
			ch.mu.Unlock()
		},
	}
	if tweak != nil {
		tweak(&o)
	}
	return NewRegistry(o), ch
}

// helperConfig is the config file that the registry's children get.
type helperConfig struct{}

func (helperConfig) Path() string                                  { return "helper.conf" }
func (helperConfig) ChildPassword(context.Context) (string, error) { return "", nil }

func newChild(name string) *Child[string] {
	return &Child[string]{Name: name, Source: "src:" + name, Started: time.Now(), Log: slog.New(slog.DiscardHandler), Own: name}
}

// spawn reserves c and starts the helper child with args. When ready is true, the child counts
// as ready as soon as it runs.
func spawn(t *testing.T, r *Registry[string], c *Child[string], ready bool, args ...string) {
	t.Helper()
	if err := r.Reserve(c, "", func([]*Child[string]) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := r.Spawn(c, Launch{
		Spec:  Spec{Rclone: append([]string{"helper"}, args...)},
		Ready: func(context.Context) (bool, error) { return ready, nil },
		Late:  func(d time.Duration) i18n.Text { return i18n.M("it never answered within %s", d) },
	}); err != nil {
		t.Fatal(err)
	}
}

// TestRegistryStartStop checks that a reserved and spawned child is starting, then running with
// its process. The service's check refuses another start at the same place, and the registry
// refuses one under the same id. A stop ends the child, publishes stopped, and removes it from
// the registry. The child runs on the config file that Configs names.
func TestRegistryStartStop(t *testing.T) {
	sup := newSupervisor(t, Options{})
	r, ch := newRegistry(t, sup, nil)
	c := newChild("a")
	spawn(t, r, c, true, "sleep")
	if !validID(c.ID) {
		t.Fatalf("id %q", c.ID)
	}
	ch.wait(t, c.ID, 1, StatusStarting)
	ch.wait(t, c.ID, 1, StatusRunning)
	if rep, own := r.View(c); rep.Status != StatusRunning || rep.PID == 0 || own != "a" {
		t.Fatalf("view %+v %q", rep, own)
	}
	if u := c.Unit(); u == nil || u.spec.ConfigPath != "helper.conf" {
		t.Fatalf("the child's config: %+v", u)
	}
	if all := r.All(); len(all) != 1 || all[0] != c || len(r.Live()) != 1 || r.Get(c.ID) != c {
		t.Fatalf("all %v", all)
	}

	again := newChild("a")
	taken := errors.New("taken")
	if err := r.Reserve(again, "", func(others []*Child[string]) error {
		for _, o := range others {
			if o.Own == again.Own {
				return taken
			}
		}
		return nil
	}); !errors.Is(err, taken) {
		t.Fatalf("the same place twice: %v", err)
	}
	if err := r.Reserve(again, c.ID, func([]*Child[string]) error { return nil }); err == nil {
		t.Fatal("the same id twice")
	}

	if err := r.Stop(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	ch.wait(t, c.ID, 1, StatusStopped)
	if r.Get(c.ID) != nil || len(r.All()) != 0 {
		t.Fatal("still in the registry after its stop")
	}
	if err := r.Stop(context.Background(), c.ID); !errors.Is(err, errGone) {
		t.Fatalf("a second stop: %v", err)
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if ch.ups != 1 || len(ch.downs) != 0 {
		t.Fatalf("up %d times, down %v", ch.ups, ch.downs)
	}
}

// TestRegistryWaitStops checks that a stop whose context ended carries on to its cleanup on its
// own goroutine. WaitStops waits for it, up to its time limit and never past its context. Once
// WaitStops returns true, the stop is over: stopped is published and the child is out of the
// registry.
func TestRegistryWaitStops(t *testing.T) {
	sup := newSupervisor(t, Options{})
	release := make(chan struct{})
	r, ch := newRegistry(t, sup, func(o *RegistryOptions[string]) {
		o.OnStop = func(context.Context, *Child[string]) func(context.Context) {
			return func(context.Context) { <-release }
		}
	})
	if !r.WaitStops(context.Background(), time.Second) {
		t.Fatal("no stop has begun, and WaitStops waited")
	}
	c := newChild("a")
	spawn(t, r, c, true, "sleep")
	ch.wait(t, c.ID, 1, StatusRunning)

	request, end := context.WithCancel(context.Background())
	end()
	if err := r.Stop(request, c.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("stop: %v, want its request's end", err)
	}
	if r.WaitStops(context.Background(), 200*time.Millisecond) {
		t.Fatal("WaitStops returned true while a stop's cleanup ran")
	}
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	if r.WaitStops(ended, time.Minute) {
		t.Fatal("WaitStops returned true past its context")
	}

	close(release)
	if !r.WaitStops(context.Background(), 30*time.Second) {
		t.Fatal("the stop did not end once its cleanup could")
	}
	ch.mu.Lock()
	stopped := slices.Contains(ch.list, change{c.ID, StatusStopped, ""})
	ch.mu.Unlock()
	if !stopped || r.Get(c.ID) != nil {
		t.Fatalf("after WaitStops: stopped said %v, in the registry %v", stopped, r.Get(c.ID) != nil)
	}
}

// TestRegistryFirstStartFails checks that a child whose process fails before it is ready is
// reported as failed with its last error line (clipped to valid UTF-8, however long), and leaves
// the registry. A child that isn't ready in time is reported as failed with the Late text.
func TestRegistryFirstStartFails(t *testing.T) {
	sup := newSupervisor(t, Options{})
	r, ch := newRegistry(t, sup, func(o *RegistryOptions[string]) { o.ReadyTimeout = 500 * time.Millisecond })

	// The 1000th byte is inside an "é".
	line := "x" + strings.Repeat("é", maxErrorText)
	c := newChild("fails")
	spawn(t, r, c, false, "fail", line)
	got := ch.wait(t, c.ID, 1, StatusFailed, StatusRunning)
	if got.st != StatusFailed || !utf8.ValidString(got.msg) || !strings.HasSuffix(got.msg, "…") ||
		!strings.HasPrefix(line, strings.TrimSuffix(got.msg, "…")) || len(got.msg) > maxErrorText+len("…") {
		t.Fatalf("got %s %.40q… (%d bytes)", got.st, got.msg, len(got.msg))
	}
	if r.Get(c.ID) != nil {
		t.Fatal("a failed child is still in the registry")
	}

	late := newChild("late")
	spawn(t, r, late, false, "sleep")
	if got := ch.wait(t, late.ID, 1, StatusFailed, StatusRunning); got.st != StatusFailed || !strings.HasSuffix(got.msg, "is not ready: it never answered within 500ms") {
		t.Fatalf("got %+v", got)
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !slices.Equal(ch.downs, []bool{false, false}) {
		t.Fatalf("down %v, want twice for good", ch.downs)
	}
}

// TestRegistryRestart checks that a child that has run and then goes down is restarting, then
// running again, and stays in the registry. The reason given is its exit, because it printed no
// error line.
func TestRegistryRestart(t *testing.T) {
	sup := newSupervisor(t, Options{})
	r, ch := newRegistry(t, sup, nil)
	c := newChild("crashes")
	spawn(t, r, c, true, "up-then-exit", "200")
	got := ch.wait(t, c.ID, 1, StatusRestarting)
	if !strings.Contains(got.msg, "exit status 1") {
		t.Fatalf("restarting %+v", got)
	}
	ch.wait(t, c.ID, 2, StatusRunning)
	if rep, _ := r.View(c); rep.Status == StatusFailed || r.Get(c.ID) != c {
		t.Fatalf("view %+v", rep)
	}
	if n, err := r.StopAll(context.Background()); err != nil || n != 1 {
		t.Fatalf("stopped %d: %v", n, err)
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if len(ch.downs) == 0 || !ch.downs[0] {
		t.Fatalf("down %v, want again", ch.downs)
	}
}

// TestRegistryResume checks that Resume offers the previous run's records of its kind in order,
// drops those that are not started again, and stops when the core stops, leaving the rest.
func TestRegistryResume(t *testing.T) {
	rec := func(id string, kind Kind) Record {
		return Record{ID: id, Kind: kind, Name: id, Args: []string{"serve"}}
	}
	sup := newSupervisor(t, Options{},
		rec("0000000a", KindServe), rec("0000000b", KindMount), rec("0000000c", KindServe),
		rec("0000000d", KindServe), rec("0000000e", KindServe),
	)
	r, _ := newRegistry(t, sup, nil)
	var offered []string
	done := r.Resume(context.Background(), func(rec Record) error {
		offered = append(offered, rec.ID)
		switch rec.ID {
		case "0000000a":
			return ErrNotRecorded
		case "0000000c":
			return nil // stays pending, because nothing started under its id
		case "0000000d":
			return fmt.Errorf("start: %w", ErrClosed)
		}
		t.Errorf("offered %s after the core stopped", rec.ID)
		return nil
	})
	if done || !slices.Equal(offered, []string{"0000000a", "0000000c", "0000000d"}) {
		t.Fatalf("done %v, offered %v", done, offered)
	}
	var left []string
	for _, p := range sup.Pending() {
		left = append(left, p.ID)
	}
	if want := []string{"0000000b", "0000000c", "0000000d", "0000000e"}; !slices.Equal(left, want) {
		t.Fatalf("pending %v, want %v", left, want)
	}
}

// clock is a time that a test moves forward.
type clock struct{ at atomic.Int64 }

func newClock() *clock {
	c := &clock{}
	c.at.Store(time.Now().UnixNano())
	return c
}

func (c *clock) now() time.Time                   { return time.Unix(0, c.at.Load()) }
func (c *clock) add(d time.Duration)              { c.at.Add(int64(d)) }
func (c *clock) tweak(o *RegistryOptions[string]) { o.Now = c.now }

func crash(t *testing.T, r *Registry[string], c *Child[string]) {
	t.Helper()
	rep, _ := r.View(c)
	p, err := os.FindProcess(rep.PID)
	if err != nil || rep.PID == 0 {
		t.Fatalf("no process for %s: %v", c.Name, err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
}

// waitLastErr waits until the registry has read c's error line.
func waitLastErr(t *testing.T, r *Registry[string], c *Child[string]) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		r.mu.Lock()
		got := c.lastErr
		r.mu.Unlock()
		if got != "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the error line was never read")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestRegistryErrorAge checks why a running child that crashed went down: its last error line
// while that line is recent, and how its process exited once the line is older than 30 s.
func TestRegistryErrorAge(t *testing.T) {
	sup := newSupervisor(t, Options{})
	clk := newClock()
	r, ch := newRegistry(t, sup, clk.tweak)
	c := newChild("crashes")
	spawn(t, r, c, true, "err-then-sleep", "ERROR the token expired")

	ch.wait(t, c.ID, 1, StatusRunning)
	waitLastErr(t, r, c)
	crash(t, r, c)
	if got := ch.wait(t, c.ID, 1, StatusRestarting); got.msg != "ERROR the token expired" {
		t.Fatalf("a fresh line: %q", got.msg)
	}

	ch.wait(t, c.ID, 2, StatusRunning)
	waitLastErr(t, r, c)
	clk.add(freshErr + time.Second)
	crash(t, r, c)
	got := ch.wait(t, c.ID, 2, StatusRestarting)
	if got.msg == "ERROR the token expired" || got.msg == "" {
		t.Fatalf("a line older than %s: %q, want how the process exited", freshErr, got.msg)
	}
	if rep, _ := r.View(c); rep.Err == nil || rep.Err.Error() != got.msg {
		t.Fatalf("view %+v, want the error %q", rep, got.msg)
	}
	if _, err := r.StopAll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestRegistryRemotesChanged checks that RemotesChanged flags the children it picks, once, and
// publishes them with their status. The flag clears when the child starts again.
func TestRegistryRemotesChanged(t *testing.T) {
	sup := newSupervisor(t, Options{})
	r, ch := newRegistry(t, sup, nil)
	a, b := newChild("a"), newChild("b")
	spawn(t, r, a, true, "sleep")
	spawn(t, r, b, true, "sleep")
	ch.wait(t, a.ID, 1, StatusRunning)
	ch.wait(t, b.ID, 1, StatusRunning)

	picks := func(c *Child[string]) bool { return c == a }
	r.RemotesChanged(picks)
	r.RemotesChanged(picks) // already flagged: nothing is published again
	if rep, _ := r.View(a); !rep.Restart || rep.Status != StatusRunning {
		t.Fatalf("a after the change: %+v", rep)
	}
	if rep, _ := r.View(b); rep.Restart {
		t.Fatalf("b, which doesn't use the remote, is flagged: %+v", rep)
	}
	ch.mu.Lock()
	n := 0
	for _, x := range ch.list {
		if x.id == a.ID && x.st == StatusRunning {
			n++
		}
	}
	ch.mu.Unlock()
	if n != 2 {
		t.Fatalf("a was published running %d times, want twice (up, then flagged)", n)
	}

	crash(t, r, a)
	ch.wait(t, a.ID, 3, StatusRunning)
	if rep, _ := r.View(a); rep.Restart {
		t.Fatalf("a after it started again: %+v", rep)
	}
	if _, err := r.StopAll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestRegistryCheck checks that Launch.Check runs before each start, and that its error fails
// that start with the error as the reason.
func TestRegistryCheck(t *testing.T) {
	sup := newSupervisor(t, Options{})
	r, ch := newRegistry(t, sup, nil)
	c := newChild("checked")
	var checks atomic.Int32
	taken := "Something already listens on 127.0.0.1:1."
	if err := r.Reserve(c, "", func([]*Child[string]) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := r.Spawn(c, Launch{
		Spec:  Spec{Rclone: []string{"helper", "sleep"}},
		Ready: func(context.Context) (bool, error) { return true, nil },
		Check: func(context.Context) error {
			if checks.Add(1) > 1 {
				return errors.New(taken)
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	ch.wait(t, c.ID, 1, StatusRunning)
	crash(t, r, c)
	ch.wait(t, c.ID, 1, StatusRestarting)
	if got := ch.wait(t, c.ID, 2, StatusRestarting); got.msg != taken {
		t.Fatalf("a restart whose check fails: %q, want %q", got.msg, taken)
	}
	if _, err := r.StopAll(context.Background()); err != nil {
		t.Fatal(err)
	}
}
