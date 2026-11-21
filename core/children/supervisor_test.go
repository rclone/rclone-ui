package children

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

// newSupervisor creates a supervisor that has begun with pending, and stops it when the test
// ends.
func newSupervisor(t *testing.T, o Options, pending ...Record) *Supervisor {
	t.Helper()
	if o.RunDir == "" {
		o.RunDir = runDir(t)
	}
	if o.Exe == "" {
		o.Exe = os.Args[0]
	}
	s := begun(t, o, pending...)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.StopAll(ctx, nil); err != nil {
			t.Errorf("StopAll: %v", err)
		}
	})
	return s
}

func begun(t *testing.T, o Options, pending ...Record) *Supervisor {
	t.Helper()
	s, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Begin(pending); err != nil {
		t.Fatal(err)
	}
	return s
}

// helperSpec returns a unit that runs the helper child. It is started like every rclone child,
// but the helper only reads its own arguments, not the flags after them or its config file. Its
// lines are read as plain lines (stdout at info level, stderr at error level).
func helperSpec(name string, args ...string) Spec {
	return Spec{Name: name, Kind: KindTunnel, Rclone: append([]string{"helper"}, args...), ConfigPath: "helper.conf",
		Parse: logs.PlainLines(logs.CompChildren, name)}
}

// downs records a unit's Downs. It ends the unit after n of them.
type downs struct {
	mu   sync.Mutex
	list []Down
	n    int
	full chan struct{}
}

func newDowns(n int) *downs { return &downs{n: n, full: make(chan struct{})} }

func (d *downs) onDown(_ *Unit, x Down) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.list = append(d.list, x)
	if len(d.list) == d.n {
		close(d.full)
		return false
	}
	return true
}

func (d *downs) get() []Down {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.list)
}

func waitClosed(t *testing.T, ch <-chan struct{}, d time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(d):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestBackoffDoublesToItsMax(t *testing.T) {
	s := newSupervisor(t, Options{})
	d := newDowns(6)
	spec := helperSpec("failing", "exit", "3")
	spec.Backoff = Backoff{Min: 10 * time.Millisecond, Max: 80 * time.Millisecond, Reset: time.Hour}
	spec.OnDown = d.onDown
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 20*time.Second, "the unit to end after its sixth down")
	var delays []time.Duration
	for i, x := range d.get() {
		delays = append(delays, x.Delay)
		if x.Attempt != i+1 {
			t.Errorf("down %d: attempt %d", i, x.Attempt)
		}
		if x.Err == nil || !strings.Contains(x.Err.Error(), "exit status 3") {
			t.Errorf("down %d: err %v", i, x.Err)
		}
	}
	ms := time.Millisecond
	if want := []time.Duration{10 * ms, 20 * ms, 40 * ms, 80 * ms, 80 * ms, 80 * ms}; !slices.Equal(delays, want) {
		t.Fatalf("delays %v, want %v", delays, want)
	}
	if u.State() != StateStopped {
		t.Fatalf("state %v after OnDown declined, want stopped", u.State())
	}
}

// TestFailedStartsLeaveNoWaiters checks that repeated failed starts leave no goroutine blocked.
// Each failed start's exit is queued for the loop that watches a running child, which a run that
// never came up doesn't reach. The next run drains the queue, so no process's waiter stays
// blocked on a full queue while the unit keeps failing.
func TestFailedStartsLeaveNoWaiters(t *testing.T) {
	s := newSupervisor(t, Options{})
	const downs = 12
	parked := -1
	d := newDowns(downs)
	spec := helperSpec("never-ready", "exit", "3")
	spec.Ready = func(ctx context.Context, _ *Process) error { <-ctx.Done(); return ctx.Err() }
	spec.Backoff = Backoff{Min: time.Millisecond, Max: 5 * time.Millisecond, Reset: time.Hour}
	spec.OnDown = func(u *Unit, x Down) bool {
		if len(d.get()) == downs-1 {
			time.Sleep(50 * time.Millisecond) // give the last waiter time to send
			parked = parkedWaiters()
		}
		return d.onDown(u, x)
	}
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 30*time.Second, "the unit to end")
	if got := d.get(); len(got) != downs || got[0].WasUp || !strings.Contains(got[0].Err.Error(), "exited before it was ready") {
		t.Fatalf("downs %+v", got)
	}
	// The queue buffers two exits without a reader, so no waiter should be blocked.
	if parked > 0 {
		t.Fatalf("%d waiters blocked on the exit queue after %d failed starts", parked, downs)
	}
}

// parkedWaiters counts the process waiters that are blocked on their unit's exit queue.
func parkedWaiters() int {
	buf := make([]byte, 1<<22)
	buf = buf[:runtime.Stack(buf, true)]
	n := 0
	for g := range strings.SplitSeq(string(buf), "\n\n") {
		lines := strings.Split(g, "\n")
		if len(lines) > 1 && strings.Contains(lines[0], "[select") &&
			strings.HasPrefix(lines[1], "github.com/rclone/rclone-ui/core/children.(*Unit).spawn.func") {
			n++
		}
	}
	return n
}

func TestBackoffResetsAfterStayingUp(t *testing.T) {
	s := newSupervisor(t, Options{})
	d := newDowns(3)
	spec := helperSpec("flaky", "up-then-exit", "300")
	spec.Backoff = Backoff{Min: 10 * time.Millisecond, Max: time.Second, Reset: 100 * time.Millisecond}
	spec.OnDown = d.onDown
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 20*time.Second, "three downs")
	for i, x := range d.get() {
		if !x.WasUp || x.UpFor < 100*time.Millisecond || x.Attempt != 1 || x.Delay != 10*time.Millisecond {
			t.Errorf("down %d = %+v, want up ≥ Reset, attempt 1, the minimum delay", i, x)
		}
	}
}

func TestRetrySteps(t *testing.T) {
	r := Backoff{Min: time.Second, Max: 3 * time.Second, Reset: time.Minute}.Retry()
	for i, want := range []time.Duration{time.Second, 2 * time.Second, 3 * time.Second, 3 * time.Second} {
		if delay, attempt := r.Next(time.Minute - 1); delay != want || attempt != i+1 {
			t.Errorf("failure %d: %v, attempt %d; want %v, attempt %d", i+1, delay, attempt, want, i+1)
		}
	}
	if delay, attempt := r.Next(time.Minute); delay != time.Second || attempt != 1 {
		t.Errorf("after staying up Reset: %v, attempt %d; want the minimum, attempt 1", delay, attempt)
	}
}

func TestStopIsNotADown(t *testing.T) {
	s := newSupervisor(t, Options{})
	up := make(chan struct{}, 1)
	spec := helperSpec("sleeper", "sleep")
	spec.OnUp = func(*Unit) { up <- struct{}{} }
	spec.OnDown = func(*Unit, Down) bool {
		t.Error("a stop was reported as a down")
		return false
	}
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	p := u.Process()
	if p == nil {
		t.Fatal("no process while up")
	}
	recs, err := readRecords(s.o.RunDir)
	if err != nil {
		t.Fatal(err)
	}
	st, err := processStartTime(p.PID())
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || recs[0].PID != p.PID() || recs[0].StartTime != st || recs[0].ID != u.ID() || recs[0].Kind != KindTunnel {
		t.Fatalf("children.json = %+v, want the running child (pid %d, start %d)", recs, p.PID(), st)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := u.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, p.exited, time.Second, "the process's exit")
	if p.Killed() != isWindows() {
		t.Fatalf("Killed() = %v after a SIGTERM that ended it", p.Killed())
	}
	if u.Process() != nil || u.State() != StateStopped {
		t.Fatal("still running after Stop")
	}
	if recs, _ := readRecords(s.o.RunDir); len(recs) != 0 {
		t.Fatalf("children.json after the stop = %+v", recs)
	}
}

// TestStartFailureRestarts checks that a child whose program can't be started also counts as a
// down, and is tried again after its backoff.
func TestStartFailureRestarts(t *testing.T) {
	s := newSupervisor(t, Options{Exe: filepath.Join(t.TempDir(), "no-such-program")})
	d := newDowns(2)
	spec := helperSpec("missing", "sleep")
	spec.Backoff = Backoff{Min: time.Millisecond, Max: time.Millisecond, Reset: time.Hour}
	spec.OnDown = d.onDown
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 10*time.Second, "two failed starts")
	for _, x := range d.get() {
		if x.Err == nil || x.WasUp {
			t.Fatalf("down %+v, want a start error", x)
		}
	}
}

func TestLines(t *testing.T) {
	got := newEntries()
	s := newSupervisor(t, Options{Emit: got.emit})
	up := make(chan struct{}, 1)
	spec := helperSpec("printer", "print")
	spec.Component, spec.Subcomponent, spec.QuietStop = logs.CompTunnel, "printer", true
	spec.Parse = logs.PlainLines(logs.CompTunnel, "printer")
	spec.OnUp = func(*Unit) { up <- struct{}{} }
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	out := got.wait(t, 10*time.Second, "from stdout", func(e logs.Record) bool { return e.Message == "hello from stdout" })
	errLine := got.wait(t, 10*time.Second, "from stderr", func(e logs.Record) bool { return e.Message == "hello from stderr" })
	if out.Level != slog.LevelInfo || errLine.Level != slog.LevelError {
		t.Errorf("levels stdout %v stderr %v, want info and error", out.Level, errLine.Level)
	}
	if out.Component != logs.CompTunnel || out.Subcomponent != "printer" {
		t.Errorf("attributed to %s/%s", out.Component, out.Subcomponent)
	}
	if isWindows() {
		return // a stop is a kill on Windows, so nothing is printed while stopping
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := u.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	loud := got.wait(t, 5*time.Second, "printed while stopping", func(e logs.Record) bool { return strings.Contains(e.Message, "very loudly") })
	if loud.Level != slog.LevelInfo {
		t.Fatalf("a QuietStop child's error while stopping is logged at %v, want info", loud.Level)
	}
}

func TestReadyFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		ready func(ctx context.Context, p *Process) error
		want  string
	}{
		{"NotReady", []string{"sleep"}, func(context.Context, *Process) error { return errors.New("port closed") }, "is not ready: port closed"},
		{"ExitedFirst", []string{"exit", "4"}, func(ctx context.Context, _ *Process) error {
			<-ctx.Done()
			return ctx.Err()
		}, "exited before it was ready"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newSupervisor(t, Options{})
			d := newDowns(1)
			spec := helperSpec("child", tc.args...)
			spec.Ready, spec.OnDown = tc.ready, d.onDown
			u, err := s.Start(spec)
			if err != nil {
				t.Fatal(err)
			}
			waitClosed(t, u.Done(), 20*time.Second, "the down")
			got := d.get()
			if len(got) != 1 || got[0].WasUp || got[0].Err == nil || !strings.Contains(got[0].Err.Error(), tc.want) {
				t.Fatalf("downs %+v, want one with %q", got, tc.want)
			}
		})
	}
}

func TestStopAllRecordsWhatComesBack(t *testing.T) {
	pending := Record{ID: "0badcafe", Kind: KindMount, Name: "/mnt/pending", Args: []string{"mount", "a:", "/mnt/pending"}, MountPoint: "/mnt/pending", Restore: true}
	s := begun(t, Options{RunDir: runDir(t), Exe: os.Args[0]}, pending)
	if got := s.Pending(); len(got) != 1 || got[0].ID != pending.ID {
		t.Fatalf("Pending() = %+v", got)
	}
	up := make(chan struct{}, 2)
	serve := helperSpec("serve", "sleep")
	serve.Kind, serve.Addr = KindServe, "127.0.0.1:8080"
	serve.OnUp = func(*Unit) { up <- struct{}{} }
	if _, err := s.Start(serve); err != nil {
		t.Fatal(err)
	}
	tunnel := helperSpec("tunnel", "sleep")
	tunnel.OnUp = func(*Unit) { up <- struct{}{} }
	if _, err := s.Start(tunnel); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	waitClosed(t, up, 10*time.Second, "OnUp")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	restoreMountsAndServes := func(r Record) bool { return true }
	if err := s.StopAll(ctx, restoreMountsAndServes); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(helperSpec("late", "sleep")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Start after StopAll: %v, want ErrClosed", err)
	}
	// A Boot that is still running (it couldn't start the pending mount, because of ErrClosed)
	// doesn't drop anything that StopAll kept.
	s.DropPending(pending.ID)
	recs, err := readRecords(s.o.RunDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, r := range recs {
		if r.PID != 0 || !r.Restore {
			t.Errorf("record %+v: want no process and restore", r)
		}
		names = append(names, r.Name)
	}
	slices.Sort(names)
	if want := []string{"/mnt/pending", "serve"}; !slices.Equal(names, want) {
		t.Fatalf("children.json keeps %v, want %v (never the tunnel)", names, want)
	}

	// The next process finds the records to start again.
	lo := ClearLeftovers(ctx, LeftoverOptions{RunDir: s.o.RunDir, unmount: noUnmount(t)})
	if len(lo.Restore) != 2 || len(lo.Killed) != 0 {
		t.Fatalf("leftovers %+v", lo)
	}
	s2 := begun(t, Options{RunDir: s.o.RunDir, Exe: os.Args[0]}, lo.Restore...)
	defer func() { _ = s2.StopAll(context.Background(), nil) }()
	again := helperSpec("serve", "sleep")
	again.ID, again.Kind = lo.Restore[slices.IndexFunc(lo.Restore, func(r Record) bool { return r.Name == "serve" })].ID, KindServe
	if _, err := s2.Start(again); err != nil {
		t.Fatal(err)
	}
	if got := s2.Pending(); len(got) != 1 || got[0].ID != pending.ID {
		t.Fatalf("after starting the serve again, pending = %+v", got)
	}
	s2.DropPending(pending.ID)
	if got := s2.Pending(); len(got) != 0 {
		t.Fatalf("after DropPending, pending = %+v", got)
	}
}

// TestStopAllSkipsWhatAUserStops checks that a unit whose stop on purpose has begun (Leave,
// called before the starter's slow part of the stop) is not kept to come back by a restart that
// begins in the meantime.
func TestStopAllSkipsWhatAUserStops(t *testing.T) {
	s := begun(t, Options{RunDir: runDir(t), Exe: os.Args[0]})
	up := make(chan struct{}, 2)
	var units []*Unit
	for _, name := range []string{"leaving", "staying"} {
		spec := helperSpec(name, "sleep")
		spec.Kind = KindServe
		spec.OnUp = func(*Unit) { up <- struct{}{} }
		u, err := s.Start(spec)
		if err != nil {
			t.Fatal(err)
		}
		units = append(units, u)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	waitClosed(t, up, 10*time.Second, "OnUp")
	units[0].Leave()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.StopAll(ctx, func(Record) bool { return true }); err != nil {
		t.Fatal(err)
	}
	recs, err := readRecords(s.o.RunDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || recs[0].Name != "staying" || !recs[0].Restore {
		t.Fatalf("children.json keeps %+v, want only the unit nobody was stopping", recs)
	}
}

func TestSpecChecks(t *testing.T) {
	s := newSupervisor(t, Options{})
	for _, spec := range []Spec{
		{},
		{Name: "no command line", ConfigPath: "x"},
		{Name: "no config file", Rclone: []string{"lsf"}},
		{Name: "bad id", Rclone: []string{"lsf"}, ConfigPath: "x", ID: "XYZ"},
	} {
		if _, err := s.Start(spec); err == nil {
			t.Errorf("Start(%+v) accepted", spec)
		}
	}
	noExe := begun(t, Options{RunDir: runDir(t)})
	if _, err := noExe.Start(helperSpec("no executable", "sleep")); err == nil {
		t.Error("a supervisor without Options.Exe started a child")
	}
}

// TestSocketsInTheirOwnFolder checks that the sockets go in their own short folder, and that
// children.json stays in the run dir however long its path is. A sockets folder that is too long
// for a socket path is refused, with an error that explains how to set another one.
func TestSocketsInTheirOwnFolder(t *testing.T) {
	if _, err := New(Options{RunDir: "/" + strings.Repeat("x", 120)}); err == nil {
		t.Fatal("a run dir too long for socket paths was accepted for the sockets")
	}
	long := filepath.Join(t.TempDir(), strings.Repeat("x", 60), strings.Repeat("y", 60))
	if err := os.MkdirAll(long, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := New(Options{RunDir: long, SocketDir: long})
	if err == nil || !strings.Contains(err.Error(), "APP_RUN_DIR") {
		t.Fatalf("a sockets' folder too long: %v", err)
	}

	sockets := runDir(t)
	s := newSupervisor(t, Options{RunDir: long, SocketDir: sockets})
	u, err := s.Start(helperSpec("child", "sleep"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(u.RC().sock) != sockets {
		t.Errorf("the rc socket %s is not in %s", u.RC().sock, sockets)
	}
	if _, err := os.Stat(filepath.Join(long, recordsFile)); err != nil {
		t.Errorf("children.json: %v", err)
	}
}

func noUnmount(t *testing.T) func(context.Context, string) error {
	return func(_ context.Context, mp string) error {
		t.Errorf("unmounted %s", mp)
		return nil
	}
}

func isWindows() bool { return filepath.Separator == '\\' }

// Until Begin, the supervisor writes nothing and starts no child, so children.json keeps the
// previous run's records. A stop then leaves them for the next start. Begin writes the records
// to start again, and children start from then on.
func TestNothingBeforeBegin(t *testing.T) {
	dir := runDir(t)
	previous := []byte(`[{"id":"0badcafe","kind":"mount","pid":1}]`)
	if err := os.WriteFile(filepath.Join(dir, recordsFile), previous, 0o600); err != nil {
		t.Fatal(err)
	}
	unchanged := func(when string) {
		t.Helper()
		if got, err := os.ReadFile(filepath.Join(dir, recordsFile)); err != nil || string(got) != string(previous) {
			t.Errorf("children.json %s: %q %v", when, got, err)
		}
	}
	s, err := New(Options{RunDir: dir, Exe: os.Args[0]})
	if err != nil {
		t.Fatal(err)
	}
	unchanged("after New")
	if _, err := s.Start(helperSpec("early", "sleep")); !errors.Is(err, errNotBegun) {
		t.Errorf("Start before Begin: %v", err)
	}
	if err := s.StopAll(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	unchanged("after a stop before Begin")

	next := begun(t, Options{RunDir: dir, Exe: os.Args[0]}, Record{ID: "0badcafe", Kind: KindMount, Name: "/mnt/a"})
	t.Cleanup(func() { _ = next.StopAll(context.Background(), nil) })
	recs, err := readRecords(dir)
	if err != nil || len(recs) != 1 || recs[0].PID != 0 || !recs[0].Restore {
		t.Fatalf("children.json after Begin: %+v %v", recs, err)
	}
}
