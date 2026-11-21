package watchers

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/transfers"
)

// The saves are checked: a name, two paths that rclone reads as meant, folders that don't
// overlap, and a name used once. Errors name their field.
func TestSaveChecks(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	f.save(Input{Name: "Docs", PathA: "/tmp/docs", PathB: "gdrive:Docs"})
	// The sentence names what a full path starts with on this OS.
	notFull := "This is not a full path. Use one that starts with /."
	if runtime.GOOS == "windows" {
		notFull = `This is not a full path. Use one that starts with a drive, as in C:\.`
	}
	for _, c := range []struct {
		in           Input
		field, error string
	}{
		{Input{Name: " ", PathA: "/a", PathB: "/b"}, "name", "Please enter a name for the watcher"},
		{Input{Name: "x", PathB: "/b"}, "pathA", "Please select Folder A"},
		{Input{Name: "x", PathA: "/a"}, "pathB", "Please select Folder B"},
		{Input{Name: "x", PathA: "tmp/a", PathB: "/b"}, "pathA", notFull},
		{Input{Name: "x", PathA: "/a", PathB: "/a/"}, "pathB", "Folder A and Folder B are the same folder."},
		{Input{Name: "x", PathA: "/a", PathB: ":local:/a"}, "pathB", "Folder A and Folder B are the same folder."},
		{Input{Name: "x", PathA: "gdrive:", PathB: "gdrive:"}, "pathB", "Folder A and Folder B are the same folder."},
		{Input{Name: "x", PathA: "/a", PathB: "/a/b"}, "pathB", "Folder A and Folder B can't be inside each other."},
		{Input{Name: "x", PathA: "gdrive:a/b/c", PathB: "gdrive:a"}, "pathB", "Folder A and Folder B can't be inside each other."},
		{Input{Name: "x", PathA: "gdrive:", PathB: "gdrive:a"}, "pathB", "Folder A and Folder B can't be inside each other."},
		{Input{Name: "docs", PathA: "/a", PathB: "/b"}, "name", "A watcher called docs exists already."},
	} {
		_, err := f.s.Save(ctx, c.in)
		if errs.FieldOf(err) != c.field || err.Error() != c.error {
			t.Errorf("%+v: %v (field %q), want %q on %s", c.in, err, errs.FieldOf(err), c.error, c.field)
		}
	}
	// Folders side by side, or on different remotes, are fine.
	f.save(Input{Name: "Near", PathA: "/a/b", PathB: "/a/bc"})
	f.save(Input{Name: "apart", PathA: "gdrive:a", PathB: "box:a"})
	ws, err := f.s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, w := range ws {
		names = append(names, w.Name)
	}
	if !slices.Equal(names, []string{"apart", "Docs", "Near"}) {
		t.Errorf("listed %v, want them by name", names)
	}
	if _, err := f.s.Save(ctx, Input{ID: "missing", Name: "y", PathA: "/a", PathB: "/b"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("editing a missing watcher: %v", err)
	}
}

// Changing a folder clears the baseline and what the watcher needed, and runs it at once. A
// rename only keeps both.
func TestEditClearsTheBaseline(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	testutil.Eventually(t, 5*time.Second, "the first run", func() bool { return r.count() == 1 })
	r.end(0, transfers.StateCompleted, "", &transfers.Summary{})
	testutil.Eventually(t, 5*time.Second, "the baseline", func() bool { return f.get(w.ID).Baselined })
	testutil.Must(t, f.s.update(ctx, w.ID, `attention = 'deletes', deleted_side = 'a'`))

	f.save(Input{ID: w.ID, Name: "Documents", PathA: "/tmp/a", PathB: "/tmp/b"})
	if got := f.get(w.ID); !got.Baselined || got.Attention != AttentionDeletes || got.Name != "Documents" {
		t.Errorf("a rename changed the run state: %+v", got)
	}
	if r.count() != 1 {
		t.Errorf("a rename ran the watcher")
	}
	f.save(Input{ID: w.ID, Name: "Documents", PathA: "/tmp/a", PathB: "/tmp/c"})
	if got := f.get(w.ID); got.Baselined || got.Attention != "" || got.DeletedSide != "" {
		t.Errorf("a new folder kept the run state: %+v", got)
	}
	testutil.Eventually(t, 5*time.Second, "a run after the change", func() bool { return r.count() == 2 })
	if p := r.params(t, 1); p["resync"] != true {
		t.Errorf("the run after a change doesn't merge: %v", p)
	}
}

// The scheduler runs a watcher at once when it is created, and every tick after. A tick while a
// run is in progress, or Sync now, starts no second run. A paused watcher and one that needs the
// user are skipped. Resume and Sync now run at once. Deleting a watcher stops its run.
func TestScheduler(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, 30*time.Millisecond)
	ctx := context.Background()
	f.run()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	testutil.Eventually(t, 5*time.Second, "the first run", func() bool { return r.count() == 1 })
	// The first run merges, newer wins, with the parameters every run has.
	p := r.params(t, 0)
	for k, v := range map[string]any{"resync": true, "resyncMode": "newer", "conflictResolve": "newer",
		"conflictLoser": "num", "resilient": true, "recover": true, "maxLock": "2m", "createEmptySrcDirs": true, "maxDelete": float64(50)} {
		if p[k] != v {
			t.Errorf("%s = %v, want %v", k, p[k], v)
		}
	}
	if r.starts[0].Form.Operation != "bisync" || r.starts[0].Origin != (transfers.Origin{Kind: transfers.OriginWatcher, ID: w.ID, Name: w.Name}) {
		t.Errorf("started %+v", r.starts[0])
	}
	// Ticks and Sync now don't start a second run while the first is in progress.
	testutil.Must(t, f.s.SyncNow(ctx, w.ID))
	time.Sleep(150 * time.Millisecond)
	if r.count() != 1 {
		t.Fatalf("%d runs while one was in progress", r.count())
	}
	r.end(0, transfers.StateCompleted, "", &transfers.Summary{Transfers: 2})
	testutil.Eventually(t, 5*time.Second, "the next tick's run", func() bool { return r.count() == 2 })
	got := f.get(w.ID)
	if !got.Baselined || got.LastResult != ResultSynced || got.LastChangeID != "t1" || got.LastTransferID != "t1" ||
		got.LastChangeAt == nil || got.LastRunAt == nil {
		t.Errorf("after the merge: %+v", got)
	}
	// Later runs don't merge.
	if p := r.params(t, 1); p["resync"] != nil || p["resyncMode"] != nil {
		t.Errorf("a later run merges: %v", p)
	}
	// An idle run is not a change.
	r.end(1, transfers.StateCompleted, "", &transfers.Summary{Checks: 4})
	testutil.Eventually(t, 5*time.Second, "the next tick's run", func() bool { return r.count() == 3 })
	if got := f.get(w.ID); got.LastChangeID != "t1" || got.LastTransferID != "t1" {
		t.Errorf("an idle run was recorded as a change: %+v", got)
	}

	// Paused, it doesn't run.
	testutil.Must(t, f.s.Pause(ctx, w.ID))
	r.end(2, transfers.StateCompleted, "", nil)
	time.Sleep(150 * time.Millisecond)
	if r.count() != 3 {
		t.Fatalf("a paused watcher ran")
	}
	// Sync now runs a paused watcher once.
	testutil.Must(t, f.s.SyncNow(ctx, w.ID))
	testutil.Eventually(t, 5*time.Second, "Sync now", func() bool { return r.count() == 4 })
	r.end(3, transfers.StateCompleted, "", nil)
	time.Sleep(150 * time.Millisecond)
	if r.count() != 4 {
		t.Fatalf("a paused watcher ran after Sync now")
	}
	// Resume runs it at once.
	testutil.Must(t, f.s.Resume(ctx, w.ID))
	testutil.Eventually(t, 5*time.Second, "the run on resume", func() bool { return r.count() == 5 })

	// Deleting it stops its run, and it runs no more.
	testutil.Must(t, f.s.Delete(ctx, w.ID))
	if !slices.Equal(r.stops, []string{"t5"}) {
		t.Errorf("stopped %v, want t5", r.stops)
	}
	r.end(4, transfers.StateStopped, "", nil)
	time.Sleep(150 * time.Millisecond)
	if r.count() != 5 {
		t.Errorf("a deleted watcher ran")
	}
	if _, err := f.s.Get(ctx, w.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after Delete: %v", err)
	}
	if len(f.published(bus.WatchersChanged)) == 0 {
		t.Error("no watchers.changed")
	}
}

// A run that bisync can't go on from makes the watcher need the user, and it stops running. A
// resync-required error asks for Resync, which merges once and lets it run again. Too many
// deletes says which folder lost them, and Force runs once with force. Other failures retry.
func TestNeedsAttention(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, 30*time.Millisecond)
	ctx := context.Background()
	f.run()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	n := 0
	next := func(state transfers.State, errText string) {
		t.Helper()
		testutil.Eventually(t, 5*time.Second, "a run", func() bool { return r.count() == n+1 })
		r.end(n, state, errText, nil)
		n++
	}
	next(transfers.StateCompleted, "") // the merge

	// An ordinary failure retries on the next tick.
	next(transfers.StateFailed, "couldn't connect")
	testutil.Eventually(t, 5*time.Second, "a retry", func() bool { return r.count() == n+1 })
	if got := f.get(w.ID); got.LastResult != ResultFailed || got.LastError != "couldn't connect" || got.Attention != "" ||
		got.LastTransferID != "t2" {
		t.Errorf("after an ordinary failure: %+v", got)
	}

	for _, c := range []struct {
		err             string
		attention, side string
	}{
		{"bisync needs a resync: bisync aborted", AttentionResync, ""},
		{"cannot find prior Path1 or Path2 listings: bisync aborted", AttentionResync, ""},
		{"too many deletes on Path1: bisync stopped", AttentionDeletes, SideA},
		{"too many deletes on Path2: bisync stopped", AttentionDeletes, SideB},
		{"too many deletes: bisync stopped", AttentionDeletes, ""},
	} {
		next(transfers.StateFailed, c.err)
		got := f.get(w.ID)
		if got.Attention != c.attention || got.DeletedSide != c.side || got.LastError != c.err {
			t.Errorf("%q: attention %q side %q", c.err, got.Attention, got.DeletedSide)
		}
		time.Sleep(150 * time.Millisecond)
		if r.count() != n {
			t.Fatalf("%q: a watcher that needs the user ran", c.err)
		}
		// Sync now doesn't run it either.
		testutil.Must(t, f.s.SyncNow(ctx, w.ID))
		time.Sleep(50 * time.Millisecond)
		if r.count() != n {
			t.Fatalf("%q: Sync now ran a watcher that needs the user", c.err)
		}
		if c.attention == AttentionDeletes {
			testutil.Must(t, f.s.Force(ctx, w.ID))
			testutil.Eventually(t, 5*time.Second, "the forced run", func() bool { return r.count() == n+1 })
			if p := r.params(t, n); p["force"] != true || p["resync"] != nil {
				t.Errorf("the forced run's parameters: %v", p)
			}
		} else {
			testutil.Must(t, f.s.Resync(ctx, w.ID))
			if got := f.get(w.ID); !got.Resyncing {
				t.Errorf("a Resync in progress isn't shown: %+v", got)
			}
			testutil.Eventually(t, 5*time.Second, "the resync", func() bool { return r.count() == n+1 })
			if p := r.params(t, n); p["resync"] != true || p["resyncMode"] != "newer" {
				t.Errorf("the resync's parameters: %v", p)
			}
		}
		next(transfers.StateCompleted, "")
		if got := f.get(w.ID); got.Attention != "" || got.DeletedSide != "" || !got.Baselined || got.LastResult != ResultSynced {
			t.Errorf("%q: after it was fixed: %+v", c.err, got)
		}
	}
	// A failed resync keeps the need, and Force after it deletes: it never merges, which would
	// bring the files back.
	next(transfers.StateFailed, "too many deletes on Path1: bisync stopped")
	testutil.Must(t, f.s.Resync(ctx, w.ID))
	next(transfers.StateFailed, "couldn't connect")
	if got := f.get(w.ID); got.Attention != AttentionDeletes || got.DeletedSide != SideA || got.Resyncing || !got.Baselined {
		t.Errorf("after a failed resync: %+v", got)
	}
	testutil.Must(t, f.s.Force(ctx, w.ID))
	testutil.Eventually(t, 5*time.Second, "the forced run", func() bool { return r.count() == n+1 })
	if p := r.params(t, n); p["force"] != true || p["resync"] != nil {
		t.Errorf("the force after a failed resync: %v", p)
	}
	next(transfers.StateFailed, "couldn't connect")
	// Even a watcher that isn't baselined is forced without a merge.
	testutil.Must(t, f.s.update(ctx, w.ID, `baselined = 0`))
	testutil.Must(t, f.s.Force(ctx, w.ID))
	testutil.Eventually(t, 5*time.Second, "the forced run", func() bool { return r.count() == n+1 })
	if p := r.params(t, n); p["force"] != true || p["resync"] != nil {
		t.Errorf("the force of a watcher without a baseline: %v", p)
	}
	next(transfers.StateFailed, "couldn't connect")
}

// A tick that finds a run's transfer closed before its end is reported doesn't free the run, as
// the transfer service writes the end before it reports it. The next run starts once the end is
// recorded, and doesn't merge again.
func TestEndReportedAfterTheTransferCloses(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	testutil.Eventually(t, 5*time.Second, "the first run", func() bool { return r.count() == 1 })
	r.vanish(0) // the end is written, and not reported yet
	f.s.tick(ctx)
	time.Sleep(50 * time.Millisecond)
	if r.count() != 1 {
		t.Fatal("a tick started a run before the end was reported")
	}
	r.end(0, transfers.StateCompleted, "", &transfers.Summary{Transfers: 1})
	testutil.Eventually(t, 5*time.Second, "the baseline", func() bool { return f.get(w.ID).Baselined })
	f.s.tick(ctx)
	testutil.Eventually(t, 5*time.Second, "the next run", func() bool { return r.count() == 2 })
	if p := r.params(t, 1); p["resync"] != nil {
		t.Errorf("the run after the end merges again: %v", p)
	}
}

// A resync asked for while a run waits to start isn't lost when that run is skipped, because the
// watcher is paused: it runs.
func TestQueuedResyncRunsWhenTheRunIsSkipped(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	testutil.Eventually(t, 5*time.Second, "the first run", func() bool { return r.count() == 1 })
	r.end(0, transfers.StateCompleted, "", nil)
	testutil.Eventually(t, 5*time.Second, "the end", func() bool { return f.get(w.ID).Baselined })
	testutil.Must(t, f.s.Pause(ctx, w.ID))
	for range 20 {
		n := r.count()
		f.s.kick(w.ID, modeNormal) // skipped: paused
		testutil.Must(t, f.s.Resync(ctx, w.ID))
		testutil.Eventually(t, 5*time.Second, "the resync", func() bool { return r.count() == n+1 })
		if p := r.params(t, n); p["resync"] != true {
			t.Fatalf("ran %v, want the resync", p)
		}
		r.end(n, transfers.StateCompleted, "", nil)
		testutil.Eventually(t, 5*time.Second, "the resync's end", func() bool { return !f.get(w.ID).Resyncing })
	}
}

// A run that can't start (nothing recorded) fails like a run that did. watcher.failed is sent
// once per streak of failures, to the targets and the desktop, which opens the Watchers window.
func TestFailureNotifiedOncePerStreak(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "/tmp/b"})
	testutil.Eventually(t, 5*time.Second, "the first run", func() bool { return r.count() == 1 })
	r.end(0, transfers.StateCompleted, "", nil)
	testutil.Eventually(t, 5*time.Second, "the end", func() bool { return f.get(w.ID).LastResult == ResultSynced })

	r.mu.Lock()
	r.refuse = errors.New("didn't find section in config file (\"gone\")\nmore")
	r.mu.Unlock()
	testutil.Must(t, f.s.SyncNow(ctx, w.ID))
	testutil.Eventually(t, 5*time.Second, "the refused run", func() bool { return f.get(w.ID).LastResult == ResultFailed })
	if got := f.get(w.ID); got.LastTransferID != "" || got.LastError == "" {
		t.Errorf("after a refused start: %+v", got)
	}
	for i := 1; i <= 3; i++ {
		testutil.Must(t, f.s.SyncNow(ctx, w.ID))
		testutil.Eventually(t, 5*time.Second, "a run", func() bool { return r.count() == i+1 })
		r.end(i, transfers.StateFailed, "couldn't connect", nil)
	}
	testutil.Eventually(t, 5*time.Second, "the notification", func() bool { return f.notes.count() == 1 })
	time.Sleep(50 * time.Millisecond)
	if f.notes.count() != 1 {
		t.Fatalf("%d notifications for one streak", f.notes.count())
	}
	if toasts := f.notes.desktop(); len(toasts) != 1 || toasts[0].Title != "Watcher failed" || toasts[0].Route != "/watchers" ||
		toasts[0].Body != "Docs: didn't find section in config file (\"gone\")" {
		t.Errorf("desktop notifications %+v", toasts)
	}
}

// A remote's rename rewrites the watchers' folders on it, which clears their baseline.
func TestRenameRemote(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r, time.Hour)
	ctx := context.Background()
	w := f.save(Input{Name: "Docs", PathA: "/tmp/a", PathB: "gdrive:Docs"})
	other := f.save(Input{Name: "Other", PathA: "/tmp/c", PathB: "gdrive2:Docs"})
	testutil.Must(t, f.s.update(ctx, w.ID, `paused = 1, baselined = 1`))
	testutil.Must(t, f.s.update(ctx, other.ID, `baselined = 1`))
	testutil.Must(t, f.s.RenameRemote(ctx, "gdrive", "drive"))
	if got := f.get(w.ID); got.PathA != "/tmp/a" || got.PathB != "drive:Docs" || got.Baselined {
		t.Errorf("renamed %+v", got)
	}
	if got := f.get(other.ID); got.PathB != "gdrive2:Docs" || !got.Baselined {
		t.Errorf("another remote's watcher changed: %+v", got)
	}
}

// A page that asks about a watcher that doesn't exist gets not_found, not invalid.
func TestAPINotFound(t *testing.T) {
	f := newFixture(t, &fakeRunner{}, time.Hour)
	ctx := context.Background()
	api := NewAPI(late.Of(f.s))
	_, getErr := api.Get(ctx, "nope")
	_, saveErr := api.Save(ctx, Input{ID: "nope", Name: "y", PathA: "/a", PathB: "/b"})
	for name, err := range map[string]error{
		"Get": getErr, "Save": saveErr,
		"Delete": api.Delete(ctx, "nope"), "Pause": api.Pause(ctx, "nope"), "Resume": api.Resume(ctx, "nope"),
		"SyncNow": api.SyncNow(ctx, "nope"), "Resync": api.Resync(ctx, "nope"), "Force": api.Force(ctx, "nope"),
	} {
		if e := rclone.ErrorOf(err); e == nil || e.Code != errs.CodeNotFound || e.What != "watcher" {
			t.Errorf("%s: %+v", name, e)
		}
	}
}
