package schedules

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/transfers"
)

// realFixture runs the schedules through a real transfer service, which tells the same
// notification targets, so a test sees everything that is sent.
func realFixture(t *testing.T) (*fixture, *transfers.Service) {
	t.Helper()
	f := newFixture(t, nil, func(o *Options) { o.Now = time.Now }) // the transfers' times are real
	return f, f.ts
}

func write(t *testing.T, path, content string) {
	t.Helper()
	testutil.Must(t, os.MkdirAll(filepath.Dir(path), 0o700))
	testutil.Must(t, os.WriteFile(path, []byte(content), 0o600))
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// runNow runs a schedule and waits for its run to end. It returns the schedule as the run left
// it.
func (f *fixture) runNow(id string) *Schedule {
	f.t.Helper()
	testutil.Must(f.t, f.s.RunNow(context.Background(), id))
	var got *Schedule
	testutil.Eventually(f.t, 30*time.Second, "the run's end", func() bool {
		got = f.get(id)
		return !got.Running
	})
	return got
}

// rows counts the transfers in History.
func (f *fixture) rows() int {
	f.t.Helper()
	var n int
	testutil.Must(f.t, f.db.Read(context.Background(), func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM transfers`).Scan(&n)
	}))
	return n
}

// sentEvents returns the events sent to the targets, and the desktop's titles.
func (f *fixture) sentEvents() (events []notifications.NotificationEvent, toasts []string) {
	for _, s := range f.notes.all() {
		events = append(events, s.event)
	}
	for _, d := range f.toasts() {
		toasts = append(toasts, d.Title)
	}
	return events, toasts
}

// A scheduled Copy through the transfer service: a run that copied files stays in History, with
// the schedule as its origin, and only job.completed goes out, with the schedule's name. The next
// run changes nothing and leaves no row. A dry run in the form is dropped at save, so the run is
// real.
func TestScheduledCopy(t *testing.T) {
	f, ts := realFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	write(t, filepath.Join(src, "a.txt"), "a")
	sc := f.save(Input{Name: "Docs", Form: form("copy", rawArgs(map[string]any{
		"sources": []string{src}, "destination": dst, "options": map[string]any{"config": map[string]any{"dry_run": true}},
	})), When: "@daily"})

	got := f.runNow(sc.ID)
	copied := filepath.Join(dst, filepath.Base(src), "a.txt") // a folder is copied into the destination
	if got.LastResult != ResultCompleted || got.LastTransferID == "" || !exists(copied) {
		t.Fatalf("first run: %+v", got)
	}
	d, err := ts.Get(context.Background(), got.LastTransferID)
	testutil.Must(t, err)
	if d.Origin != (transfers.Origin{Kind: transfers.OriginSchedule, ID: sc.ID, Name: "Docs"}) || d.IsDryRun {
		t.Errorf("the transfer: %+v", d.Transfer)
	}
	events, toasts := f.sentEvents()
	if !slices.Equal(events, []notifications.NotificationEvent{notifications.NotificationEventJobCompleted}) || len(toasts) != 0 ||
		f.notes.all()[0].job.Schedule != "Docs" {
		t.Errorf("sent %v, toasts %v", events, toasts)
	}

	got = f.runNow(sc.ID)
	if got.LastResult != ResultNothing || got.LastTransferID != "" || f.rows() != 1 {
		t.Errorf("a run that changed nothing: %+v, %d rows", got, f.rows())
	}
	if events, _ := f.sentEvents(); len(events) != 1 {
		t.Errorf("a run that changed nothing sent %v", events)
	}

	// A retry from History is the user's own run: it keeps the schedule as its origin, but the
	// schedule's last run stays as it was. The run fails on a folder that has the new file's
	// name, which rclone doesn't write over on any OS.
	write(t, filepath.Join(src, "b.txt"), "b")
	inTheWay := filepath.Join(filepath.Dir(copied), "b.txt")
	testutil.Must(t, os.Mkdir(inTheWay, 0o700))
	got = f.runNow(sc.ID)
	if got.LastResult != ResultFailed || got.LastTransferID == "" {
		t.Fatalf("a failed run: %+v", got)
	}
	testutil.Must(t, os.Remove(inTheWay))
	retry, err := ts.Retry(context.Background(), got.LastTransferID, nil)
	testutil.Must(t, err)
	testutil.Eventually(t, 30*time.Second, "the retry's end", func() bool {
		open, err := ts.Open(context.Background(), retry.ID)
		return err == nil && !open
	})
	rd, err := ts.Get(context.Background(), retry.ID)
	testutil.Must(t, err)
	if rd.Origin != d.Origin || rd.State != transfers.StateCompleted {
		t.Errorf("the retry: %+v", rd.Transfer)
	}
	if after := f.get(sc.ID); after.LastTransferID != got.LastTransferID || after.LastResult != ResultFailed {
		t.Errorf("the retry counted as the schedule's run: %+v", after)
	}
	// The retry is the user's, so the transfer service told about it.
	events, _ = f.sentEvents()
	if !slices.Contains(events, notifications.NotificationEventJobStarted) {
		t.Errorf("the retry wasn't told about: %v", events)
	}
}

// A run that fails within the first second is recorded as failed, and the targets and the desktop
// hear about it once, from the scheduler, as "{name} failed". A run refused before it starts
// leaves no row, and is told about the same way.
func TestScheduledFailures(t *testing.T) {
	f, _ := realFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	write(t, filepath.Join(src, "a.txt"), "a")
	// A file has the name of the folder that the copy makes, so the copy fails on any OS.
	write(t, filepath.Join(dst, filepath.Base(src)), "in the way")
	sc := f.save(Input{Name: "Docs", Form: form("copy", copyArgs([]string{src}, dst)), When: "@daily"})
	got := f.runNow(sc.ID)
	if got.LastResult != ResultFailed || got.LastTransferID == "" || f.rows() != 1 {
		t.Fatalf("an early failure: %+v", got)
	}
	testutil.Eventually(t, 5*time.Second, "the toast", func() bool { return len(f.toasts()) == 1 })
	events, toasts := f.sentEvents()
	if !slices.Equal(events, []notifications.NotificationEvent{notifications.NotificationEventJobFailed}) ||
		!slices.Equal(toasts, []string{"Docs failed"}) || !strings.HasPrefix(f.toasts()[0].Route, "/history?id=") {
		t.Errorf("an early failure sent %v, toasts %v", events, f.toasts())
	}

	missing := filepath.Join(src, "gone")
	sc2 := f.save(Input{Name: "Gone", Form: form("copy", copyArgs([]string{src}, dst)), When: "@daily"})
	testutil.Must(t, f.s.update(context.Background(), sc2.ID, `args = ?`, string(copyArgs([]string{missing}, dst))))
	got = f.runNow(sc2.ID)
	if got.LastResult != ResultFailed || got.LastTransferID != "" || !strings.Contains(got.LastError, "Source does not exist") ||
		f.rows() != 1 {
		t.Errorf("a refused run: %+v, %d rows", got, f.rows())
	}
	events, toasts = f.sentEvents()
	if len(events) != 2 || events[1] != notifications.NotificationEventJobFailed || !slices.Equal(toasts, []string{"Docs failed", "Gone failed"}) {
		t.Errorf("a refused run sent %v, toasts %v", events, toasts)
	}
}

// A scheduled Move and Purge remove their own source, so the next runs have nothing to do and
// leave no trace. A Move leaves out the one source that is gone. A Delete of a folder keeps the
// folder and runs again.
func TestMoveAndPurgeRunOutOfSources(t *testing.T) {
	f, _ := realFixture(t)
	dir, dst := t.TempDir(), t.TempDir()
	one, two := filepath.Join(dir, "one.txt"), filepath.Join(dir, "two.txt")
	write(t, one, "1")
	write(t, two, "2")
	mv := f.save(Input{Name: "Move", Form: form("move", copyArgs([]string{one, two}, dst)), When: "@daily"})
	write(t, filepath.Join(dst, "keep"), "")
	testutil.Must(t, os.Remove(two)) // gone before the first run
	got := f.runNow(mv.ID)
	if got.LastResult != ResultCompleted || exists(one) || !exists(filepath.Join(dst, "one.txt")) {
		t.Fatalf("the first move: %+v", got)
	}
	got = f.runNow(mv.ID)
	if got.LastResult != ResultNothing || got.LastTransferID != "" {
		t.Errorf("the second move: %+v", got)
	}

	purged := filepath.Join(t.TempDir(), "old")
	write(t, filepath.Join(purged, "x.txt"), "x")
	pg := f.save(Input{Name: "Purge", Form: form("purge", rawArgs(map[string]any{"sources": []string{purged}})), When: "@daily"})
	if got := f.runNow(pg.ID); got.LastResult != ResultCompleted || exists(purged) {
		t.Fatalf("the first purge: %+v", got)
	}
	if got := f.runNow(pg.ID); got.LastResult != ResultNothing {
		t.Errorf("the second purge: %+v", got)
	}

	kept := filepath.Join(t.TempDir(), "tmp")
	write(t, filepath.Join(kept, "y.txt"), "y")
	del := f.save(Input{Name: "Delete", Form: form("delete", rawArgs(map[string]any{"sources": []string{kept}})), When: "@daily"})
	if got := f.runNow(del.ID); got.LastResult != ResultCompleted || !exists(kept) || exists(filepath.Join(kept, "y.txt")) {
		t.Fatalf("the first delete: %+v", got)
	}
	if got := f.runNow(del.ID); got.LastResult != ResultNothing {
		t.Errorf("the second delete: %+v", got)
	}
	events, toasts := f.sentEvents()
	if len(events) != 3 || len(toasts) != 0 {
		t.Errorf("sent %v, toasts %v", events, toasts)
	}
}

// A scheduled bisync: its first run finds no listings, which leaves no trace, and the scheduler
// merges the folders at once, newer wins, which baselines it. After a critical error (rclone sets
// its listings aside as .lst-err), a baselined schedule fails with what to do, and doesn't merge
// on its own. Merge again merges the folders and the runs go on.
func TestScheduledBisync(t *testing.T) {
	f, _ := realFixture(t)
	a, b := t.TempDir(), t.TempDir()
	write(t, filepath.Join(a, "only-a.txt"), "a")
	write(t, filepath.Join(b, "only-b.txt"), "b")
	sc := f.save(Input{Name: "Pair", Form: form("bisync", rawArgs(map[string]any{
		"source": a, "destination": b, "options": map[string]any{"outer": map[string]any{"force": true}},
	})), When: "@daily"})
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	var got *Schedule
	testutil.Eventually(t, 30*time.Second, "the first merge", func() bool {
		got = f.get(sc.ID)
		return got.Baselined && !got.Running
	})
	if got.LastResult != ResultCompleted || !exists(filepath.Join(a, "only-b.txt")) || !exists(filepath.Join(b, "only-a.txt")) {
		t.Fatalf("after the first merge: %+v", got)
	}
	if f.rows() != 1 {
		t.Errorf("%d rows: the first run that found no listings stayed in History", f.rows())
	}

	write(t, filepath.Join(a, "new.txt"), "n")
	if got = f.runNow(sc.ID); got.LastResult != ResultCompleted || !exists(filepath.Join(b, "new.txt")) {
		t.Fatalf("a run: %+v", got)
	}

	// A critical error sets the listings aside. (With recover, bisync goes back to the backups
	// of the listings by itself, so they are set aside too.)
	lists, _ := filepath.Glob(filepath.Join(f.s.o.Workdir, "*.lst*"))
	if len(lists) < 2 {
		t.Fatalf("listings: %v", lists)
	}
	for _, l := range lists {
		testutil.Must(t, os.Rename(l, l+"-err"))
	}
	got = f.runNow(sc.ID)
	if got.LastResult != ResultFailed || got.LastError != "Bisync needs a merge. Choose Merge again in the schedule's menu." || !got.Baselined {
		t.Fatalf("after a critical error: %+v", got)
	}
	time.Sleep(200 * time.Millisecond)
	if got := f.get(sc.ID); got.Running {
		t.Fatal("a baselined schedule merged on its own")
	}
	_, toasts := f.sentEvents()
	if !slices.Equal(toasts, []string{"Pair failed"}) {
		t.Errorf("toasts: %v", toasts)
	}

	testutil.Must(t, f.s.MergeAgain(context.Background(), sc.ID))
	testutil.Eventually(t, 30*time.Second, "the merge", func() bool {
		got = f.get(sc.ID)
		return !got.Running && got.LastResult != ResultFailed
	})
	if !got.Baselined {
		t.Errorf("after Merge again: %+v", got)
	}
	write(t, filepath.Join(b, "later.txt"), "l")
	if got = f.runNow(sc.ID); got.LastResult != ResultCompleted || !exists(filepath.Join(a, "later.txt")) {
		t.Errorf("a run after Merge again: %+v", got)
	}
	if len(f.published(bus.SchedulesChanged)) == 0 {
		t.Error("no schedules.changed")
	}
}
