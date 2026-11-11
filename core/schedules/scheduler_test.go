package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/transfers"
)

// daily saves a Copy that runs every day at 13:00 UTC. The fixture's clock is 12:00:30.
func daily(f *fixture, name string) *Schedule {
	return f.save(Input{Name: name, Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "0 13 * * *"})
}

// A schedule runs once at its time, through the transfer service, with the schedule's id and name
// as its origin, and with a preset that reopens the page. The next tick in the same minute
// starts nothing.
func TestRunsAtItsTime(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	f.tick()
	if r.count() != 0 {
		t.Fatalf("ran before its time: %d", r.count())
	}
	f.at(time.Date(2026, 11, 6, 13, 0, 0, 500_000_000, time.UTC))
	f.tick()
	f.tick()
	if r.count() != 1 {
		t.Fatalf("%d runs at 13:00, want 1", r.count())
	}
	spec := r.spec(0)
	if spec.Form.Operation != "copy" || spec.Owner == nil ||
		spec.Origin != (transfers.Origin{Kind: transfers.OriginSchedule, ID: sc.ID, Name: "Photos"}) {
		t.Errorf("start: %+v", spec)
	}
	if preset, _ := json.Marshal(spec.Preset); string(preset) != `{"operation":"copy","copy":{"sources":["/a"],"destination":"/b"}}` {
		t.Errorf("preset: %s", preset)
	}
	got := f.get(sc.ID)
	if !got.Running || got.RunningID != "t1" {
		t.Errorf("while running: %+v", got)
	}
	if due := f.lastDue(sc.ID); !due.Equal(time.Date(2026, 11, 6, 13, 0, 0, 0, time.UTC)) {
		t.Errorf("last due %v", due)
	}
	r.end(0, transfers.StateCompleted, "", changed)
	got = f.get(sc.ID)
	if got.Running || got.LastResult != ResultCompleted || got.LastTransferID != "t1" || got.LastRunAt == nil {
		t.Errorf("after the run: %+v", got)
	}
	if next := time.UnixMilli(*got.NextRun).UTC(); !next.Equal(time.Date(2026, 11, 7, 13, 0, 0, 0, time.UTC)) {
		t.Errorf("next run %v", next)
	}
}

// When the app was closed through many times, the schedule runs once, after the wait that
// follows the start, and its last due is the latest time that passed.
func TestManyMissedTimesRunOnce(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	f.at(time.Date(2026, 11, 10, 18, 0, 0, 0, time.UTC)) // four days later, as at a start
	f.s.boot(f.ctx)
	f.tick()
	if r.count() != 0 {
		t.Fatal("ran during the wait after the start")
	}
	f.advance(30 * time.Second)
	f.tick()
	if r.count() != 0 {
		t.Fatal("ran before the wait ended")
	}
	f.advance(31 * time.Second)
	f.tick()
	if r.count() != 1 {
		t.Fatalf("%d runs, want 1", r.count())
	}
	if due := f.lastDue(sc.ID); !due.Equal(time.Date(2026, 11, 10, 13, 0, 0, 0, time.UTC)) {
		t.Errorf("last due %v", due)
	}
}

// A computer that slept through a time runs it once, after a wait like the one after a start.
func TestAWakeWaitsToo(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	daily(f, "Photos")
	f.tick()
	f.sleep(3 * time.Hour) // asleep through 13:00
	f.tick()
	if r.count() != 0 {
		t.Fatal("ran at once after the wake")
	}
	f.advance(f.s.o.Wait)
	f.tick()
	if r.count() != 1 {
		t.Fatalf("%d runs after the wait, want 1", r.count())
	}
}

// The runs that catch up wait while the config is locked, and start 10 s apart once it is
// unlocked.
func TestCatchUpWaitsForTheConfigAndSpacesTheStarts(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	for _, name := range []string{"A", "B", "C"} {
		daily(f, name)
	}
	f.locked = true
	f.at(time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC))
	f.s.boot(f.ctx)
	f.advance(2 * time.Minute)
	f.tick()
	if r.count() != 0 {
		t.Fatal("ran while the config was locked")
	}
	f.clockMu.Lock()
	f.locked, f.waits = false, nil
	f.clockMu.Unlock()
	f.advance(time.Minute)
	f.tick()
	if r.count() != 3 {
		t.Fatalf("%d runs after the unlock, want 3", r.count())
	}
	if !slices.Equal(f.waits, []time.Duration{10 * time.Second, 10 * time.Second}) {
		t.Errorf("waits between the starts: %v", f.waits)
	}
}

// Creating a schedule, resuming it, or changing its time counts its times from now, so a time that
// has passed doesn't start a run. Run now runs a paused schedule and doesn't change its last due.
func TestNoCatchUpAfterCreateResumeOrEdit(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	// Every minute: any change of the clock would make it due.
	sc := f.save(Input{Name: "Often", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "*/30 * * * *"})
	f.tick()
	if r.count() != 0 {
		t.Fatal("a new schedule ran for a past time")
	}
	testutil.Must(t, f.s.Pause(context.Background(), sc.ID))
	f.advance(2 * time.Hour)
	f.tick()
	f.advance(f.s.o.Wait)
	f.tick()
	if r.count() != 0 {
		t.Fatal("a paused schedule ran")
	}
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	if r.count() != 1 {
		t.Fatal("Run now didn't run a paused schedule")
	}
	if err := f.s.RunNow(context.Background(), sc.ID); err == nil || !errs.Is(err) {
		t.Errorf("Run now during a run: %v", err)
	}
	before := f.lastDue(sc.ID)
	r.end(0, transfers.StateCompleted, "", changed)
	if !f.lastDue(sc.ID).Equal(before) {
		t.Error("Run now changed the last due")
	}
	testutil.Must(t, f.s.Resume(context.Background(), sc.ID))
	f.tick()
	if r.count() != 1 {
		t.Fatal("resuming started a catch-up run")
	}
	f.sleep(2 * time.Hour)
	f.tick() // the wait after a wake
	in := Input{ID: sc.ID, Name: "Often", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "*/20 * * * *"}
	if _, err := f.s.Save(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	f.advance(f.s.o.Wait)
	f.tick()
	if r.count() != 1 {
		t.Fatal("changing the time started a catch-up run")
	}
}

// A clock set back moves the last due back to now, so the schedule runs at its next time instead
// of waiting until the clock catches up.
func TestClockSetBack(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	f.at(time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC))
	sc := daily(f, "Photos")
	f.at(time.Date(2026, 11, 6, 12, 30, 0, 0, time.UTC))
	f.tick()
	if due := f.lastDue(sc.ID); !due.Equal(f.clock()) {
		t.Fatalf("last due %v after the clock went back to %v", due, f.clock())
	}
	f.advance(f.s.o.Wait)
	f.tick()
	f.at(time.Date(2026, 11, 6, 13, 0, 1, 0, time.UTC))
	f.tick()
	if r.count() != 1 {
		t.Fatalf("%d runs at the next time, want 1", r.count())
	}
}

// When a schedule is due while its run is still going, the time is skipped and recorded. The
// skip is cleared when the next run starts. Pausing during a run lets it finish.
func TestOverlapIsSkipped(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := f.save(Input{Name: "Hourly", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "0 * * * *"})
	f.at(time.Date(2026, 11, 6, 13, 0, 1, 0, time.UTC))
	f.tick()
	f.at(time.Date(2026, 11, 6, 14, 0, 1, 0, time.UTC))
	f.tick()
	if r.count() != 1 {
		t.Fatalf("%d runs, want 1", r.count())
	}
	got := f.get(sc.ID)
	if got.LastSkippedAt == nil || *got.LastSkippedAt != time.Date(2026, 11, 6, 14, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("skipped: %+v", got.LastSkippedAt)
	}
	testutil.Must(t, f.s.Pause(context.Background(), sc.ID))
	r.end(0, transfers.StateCompleted, "", changed)
	if got := f.get(sc.ID); got.LastResult != ResultCompleted || !got.Paused {
		t.Errorf("a run paused in progress: %+v", got)
	}
	testutil.Must(t, f.s.Resume(context.Background(), sc.ID))
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	if got := f.get(sc.ID); got.LastSkippedAt != nil {
		t.Errorf("the skip stayed after the next run started: %v", *got.LastSkippedAt)
	}
}

// What a run records and sends: a run that changed nothing records "nothing to do" and sends
// nothing; one that changed something sends job.completed with the schedule's name and no
// desktop notification; a failure sends job.failed and "{name} failed" on the desktop, which opens
// the run in History. A stop and an interrupted run send nothing. No run ever sends job.started.
func TestWhatARunRecordsAndSends(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	run := func(i int, state transfers.State, errText string, stats *transfers.Summary) *Schedule {
		t.Helper()
		testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
		f.goes.Wait()
		r.end(i, state, errText, stats)
		return f.get(sc.ID)
	}
	if got := run(0, transfers.StateCompleted, "", &transfers.Summary{Checks: 4}); got.LastResult != ResultNothing ||
		got.LastTransferID != "" {
		t.Errorf("nothing changed: %+v", got)
	}
	if n := len(f.notes.all()); n != 0 || len(f.toasts()) != 0 {
		t.Errorf("a run that changed nothing sent %d notifications and %d toasts", n, len(f.toasts()))
	}
	if got := run(1, transfers.StateCompleted, "", changed); got.LastResult != ResultCompleted || got.LastTransferID != "t2" {
		t.Errorf("changed: %+v", got)
	}
	sentNow := f.notes.all()
	if len(sentNow) != 1 || sentNow[0].event != notifications.NotificationEventJobCompleted ||
		sentNow[0].job.Schedule != "Photos" || sentNow[0].job.JobID != 2 || len(f.toasts()) != 0 {
		t.Errorf("completed: %+v, toasts %+v", sentNow, f.toasts())
	}
	if got := run(2, transfers.StateFailed, "couldn't connect", nil); got.LastResult != ResultFailed ||
		got.LastError != "couldn't connect" || got.LastTransferID != "t3" {
		t.Errorf("failed: %+v", got)
	}
	sentNow = f.notes.all()
	if len(sentNow) != 2 || sentNow[1].event != notifications.NotificationEventJobFailed || sentNow[1].job.Error != "couldn't connect" {
		t.Errorf("failed: %+v", sentNow)
	}
	toasts := f.toasts()
	if len(toasts) != 1 || toasts[0].Title != "Photos failed" || toasts[0].Route != "/history?id=t3" || !toasts[0].ToastOnly {
		t.Errorf("toasts: %+v", toasts)
	}
	if got := run(3, transfers.StateFailed, "1 of 1 operations failed", nil); got.LastError != "couldn't connect SSH: connection refused" {
		t.Errorf("a step's failure: %q", got.LastError)
	}
	if got := run(4, transfers.StateFailed, "2 of 3 operations failed", nil); got.LastError !=
		"2 of 3 operations failed: couldn't connect SSH: connection refused" {
		t.Errorf("failures of several steps: %q", got.LastError)
	}
	if got := run(5, transfers.StateStopped, "", nil); got.LastResult != ResultStopped {
		t.Errorf("stopped: %+v", got)
	}
	if got := run(6, transfers.StateInterrupted, "", nil); got.LastResult != ResultInterrupted {
		t.Errorf("interrupted: %+v", got)
	}
	if n := len(f.notes.all()); n != 4 {
		t.Errorf("%d notifications after a stop and an interruption, want 2", n)
	}
	for _, s := range f.notes.all() {
		if s.event == notifications.NotificationEventJobStarted {
			t.Error("job.started was sent")
		}
	}
}

// A run refused before it started records the error without a transfer, and tells the targets
// and the desktop, whose notification opens the Schedules window.
func TestRefusedRun(t *testing.T) {
	r := &fakeRunner{refuse: []error{errs.New("couldn't find remote \"gone\"")}}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	got := f.get(sc.ID)
	if got.LastResult != ResultFailed || got.LastTransferID != "" || got.LastError != `couldn't find remote "gone"` || got.Running {
		t.Fatalf("refused: %+v", got)
	}
	sentNow := f.notes.all()
	if len(sentNow) != 1 || sentNow[0].event != notifications.NotificationEventJobFailed || sentNow[0].job.Schedule != "Photos" ||
		!slices.Equal(sentNow[0].job.Sources, []string{"/a"}) || sentNow[0].job.Destination != "/b" {
		t.Errorf("sent: %+v", sentNow)
	}
	if toasts := f.toasts(); len(toasts) != 1 || toasts[0].Title != "Photos failed" || toasts[0].Route != "/schedules" {
		t.Errorf("toasts: %+v", toasts)
	}
}

// A Move, Delete or Purge leaves out the sources that are gone. With none left, the run has
// nothing to do: nothing is recorded in History or sent.
func TestMissingSourcesAreLeftOut(t *testing.T) {
	missing := func(p string) error { return errs.Errorf("%w", &operations.SourceMissingError{Path: p}) }
	r := &fakeRunner{refuse: []error{missing("/a")}}
	f := newFixture(t, r)
	f.boot()
	sc := f.save(Input{Name: "Inbox", Form: form("move", copyArgs([]string{"/a", "/b"}, "/c")), When: "@daily"})
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	if r.count() != 1 || r.args(t, 0) != `{"sources":["/b"],"destination":"/c"}` {
		t.Fatalf("starts: %d, %s", r.count(), r.args(t, 0))
	}
	r.end(0, transfers.StateCompleted, "", changed)
	r.refuse = []error{missing("/a"), missing("/b")}
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	if got := f.get(sc.ID); got.LastResult != ResultNothing || got.Running || r.count() != 1 {
		t.Fatalf("all gone: %+v, %d starts", got, r.count())
	}
	if n := len(f.notes.all()); n != 1 { // the first run's job.completed
		t.Errorf("%d notifications", n)
	}
	// A Copy whose source is missing fails.
	cp := daily(f, "Copy")
	r.refuse = []error{missing("/a")}
	testutil.Must(t, f.s.RunNow(context.Background(), cp.ID))
	f.goes.Wait()
	if got := f.get(cp.ID); got.LastResult != ResultFailed {
		t.Errorf("a copy without its source: %+v", got)
	}
}

// Editing a schedule during its run leaves the run as it started. Deleting it lets the run finish,
// and its end changes nothing.
func TestEditOrDeleteDuringARun(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	f.save(Input{ID: sc.ID, Name: "Photos 2", Form: form("copy", copyArgs([]string{"/x"}, "/y")), When: "0 13 * * *"})
	if args := r.args(t, 0); args != `{"sources":["/a"],"destination":"/b"}` {
		t.Errorf("the run's form: %s", args)
	}
	r.end(0, transfers.StateCompleted, "", changed)
	if got := f.get(sc.ID); got.LastResult != ResultCompleted || got.Name != "Photos 2" {
		t.Errorf("after an edit: %+v", got)
	}
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	testutil.Must(t, f.s.Delete(context.Background(), sc.ID))
	r.end(1, transfers.StateFailed, "boom", nil)
	if _, err := f.s.Get(context.Background(), sc.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("after a delete: %v", err)
	}
	if n := len(f.notes.all()); n != 1 {
		t.Errorf("a deleted schedule's end sent notifications: %d", n)
	}
}

// A run cut short by a quit runs once more at the next start, after the wait. A run whose end was
// never recorded takes its transfer's state. After a crash, nothing runs again. A stopped run
// doesn't run again.
func TestInterruptedRunsRunAgain(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	a, b, c := daily(f, "A"), daily(f, "B"), daily(f, "C")
	for i, sc := range []*Schedule{a, b, c} {
		testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
		f.goes.Wait()
		_ = i
	}
	r.end(0, transfers.StateInterrupted, "", nil) // A: its end was recorded at the quit
	r.end(2, transfers.StateStopped, "", nil)     // C: stopped by the user
	// B's end was never recorded: its transfer is still open in the record, so it was cut short.
	testutil.Must(t, f.db.Write(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(context.Background(), `INSERT INTO transfers (id, seq, created_ms, state, operation,
			sources, origin_kind, request, stats_group) VALUES ('t2', 2, 1, 'interrupted', 'copy', '[]', 'schedule', '{}', 'g')`)
		return err
	}))

	// The next start.
	g := newFixture(t, r, func(o *Options) {})
	g.db, g.s.o.DB = f.db, f.db
	g.at(f.clock().Add(10 * time.Minute))
	g.s.boot(g.ctx)
	if got := g.get(b.ID); got.LastResult != ResultInterrupted || got.LastTransferID != "t2" {
		t.Errorf("B's end: %+v", got)
	}
	g.tick()
	if r.count() != 3 {
		t.Fatal("ran again during the wait")
	}
	g.advance(g.s.o.Wait)
	g.tick()
	if r.count() != 5 {
		t.Fatalf("%d starts, want A and B again", r.count())
	}
	names := []string{r.spec(3).Origin.Name, r.spec(4).Origin.Name}
	slices.Sort(names)
	if !slices.Equal(names, []string{"A", "B"}) {
		t.Errorf("ran again: %v", names)
	}
	g.tick()
	if r.count() != 5 {
		t.Error("ran again twice")
	}

	// After a crash, a run cut short doesn't run again.
	r.end(3, transfers.StateInterrupted, "", nil)
	h := newFixture(t, r, func(o *Options) { o.Crashed = true })
	h.s.o.DB = f.db
	h.at(g.clock().Add(10 * time.Minute))
	h.boot()
	h.tick()
	if r.count() != 5 {
		t.Errorf("ran again after a crash: %d", r.count())
	}
}

// Every scheduled bisync runs unattended: resilient, recover, and a lock that expires, without
// force, resync or dry run whatever its form says. A merge is a resync, newer wins. A bisync that
// was never merged keeps quiet about a run that finds no listings, and a baselined one only about
// a run that asks for a merge.
func TestBisyncRunsUnattended(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	f.boot()
	sc := f.save(Input{Name: "Pair", Form: form("bisync", json.RawMessage(`{"source":"/a","destination":"/b","options":{"outer":{"force":true,"maxDelete":10}}}`)), When: "@daily"})
	outer := func(i int) map[string]any {
		var a struct {
			Options map[string]map[string]any `json:"options"`
		}
		testutil.Must(t, json.Unmarshal([]byte(r.args(t, i)), &a))
		return a.Options["outer"]
	}
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	o := outer(0)
	if o["resilient"] != true || o["recover"] != true || o["maxLock"] != "2m" || o["force"] != nil || o["resync"] != nil ||
		o["maxDelete"] != float64(10) || o["workdir"] != f.s.o.Workdir {
		t.Errorf("a run: %v", o)
	}
	quiet := r.spec(0).Owner.Quiet
	if !quiet(transfers.StateFailed, "cannot find prior Path1 or Path2 listings, likely…", nil) ||
		quiet(transfers.StateFailed, "couldn't connect", nil) ||
		quiet(transfers.StateFailed, "cannot find prior Path1 or Path2 listings", changed) {
		t.Error("the quiet failures of a bisync that was never merged")
	}
	// The run found no listings: a merge starts at once.
	r.end(0, transfers.StateFailed, "cannot find prior Path1 or Path2 listings", nil)
	f.goes.Wait()
	if r.count() != 2 {
		t.Fatalf("%d starts: no merge", r.count())
	}
	if o := outer(1); o["resync"] != true || o["resyncMode"] != "newer" ||
		r.spec(1).Owner.Quiet(transfers.StateFailed, "cannot find prior Path1 or Path2 listings", nil) ||
		!r.spec(1).Owner.Quiet(transfers.StateCompleted, "", nil) {
		t.Errorf("the merge: %v", o)
	}
	r.end(1, transfers.StateCompleted, "", changed)
	if got := f.get(sc.ID); !got.Baselined || got.LastResult != ResultCompleted {
		t.Fatalf("after the merge: %+v", got)
	}
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()
	quiet = r.spec(2).Owner.Quiet
	if quiet(transfers.StateFailed, "bisync needs a resync", nil) || !quiet(transfers.StateFailed, "bisync needs a merge", nil) {
		t.Error("the quiet failures of a baselined bisync")
	}
	r.end(2, transfers.StateFailed, "too many deletes on Path2 - 60% > 50%", nil)
	f.goes.Wait()
	got := f.get(sc.ID)
	if r.count() != 3 || got.LastError != "Many files were deleted in /b, so the bisync stopped. If that was meant, run the "+
		"Bisync page once with Force. To bring them back, choose Merge again." {
		t.Errorf("too many deletes: %d starts, %q", r.count(), got.LastError)
	}
}
