package watchers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/transfers"
)

// realFixture runs the watchers through a real transfer service, so each run is a bisync.
func realFixture(t *testing.T) (*fixture, *transfers.Service) {
	t.Helper()
	f := newFixture(t, nil, time.Hour)
	return f, f.ts
}

func write(t *testing.T, path, content string, at time.Time) {
	t.Helper()
	testutil.Must(t, os.MkdirAll(filepath.Dir(path), 0o700))
	testutil.Must(t, os.WriteFile(path, []byte(content), 0o600))
	testutil.Must(t, os.Chtimes(path, at, at))
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// syncNow runs w once and waits for its run to end. It returns the watcher as the run left it.
func (f *fixture) syncNow(w *Watcher, do func(context.Context, string) error) *Watcher {
	f.t.Helper()
	before := f.get(w.ID).LastRunAt
	testutil.Must(f.t, do(context.Background(), w.ID))
	var got *Watcher
	testutil.Eventually(f.t, 30*time.Second, "the run's end", func() bool {
		got = f.get(w.ID)
		return got.LastRunAt != nil && (before == nil || *got.LastRunAt != *before)
	})
	return got
}

// The first run merges the folders, newer wins, and deletes nothing. Later runs copy changes both
// ways, and keep both versions of a file changed on both sides. A run that changed nothing is
// dropped from History, and the others are kept. Many files deleted on one side stop the watcher
// with that side; Force deletes them on the other side, and Resync brings them back. Listings
// that are gone need a resync.
func TestRuns(t *testing.T) {
	f, ts := realFixture(t)
	ctx := context.Background()
	a, b := t.TempDir(), t.TempDir()
	old, recent := time.Now().Add(-time.Hour), time.Now().Add(-time.Minute)
	write(t, filepath.Join(a, "only-a.txt"), "a", old)
	write(t, filepath.Join(b, "only-b.txt"), "b", old)
	write(t, filepath.Join(a, "both.txt"), "old", old)
	write(t, filepath.Join(b, "both.txt"), "new", recent)
	for _, name := range []string{"1", "2", "3", "4", "5"} {
		write(t, filepath.Join(a, "many", name+".txt"), name, old)
	}

	w := f.save(Input{Name: "Docs", PathA: a, PathB: b})
	var got *Watcher
	testutil.Eventually(t, 30*time.Second, "the first merge", func() bool {
		got = f.get(w.ID)
		return got.LastRunAt != nil
	})
	if got.LastResult != ResultSynced || !got.Baselined || got.LastChangeID == "" {
		t.Fatalf("after the merge: %+v", got)
	}
	for _, dir := range []string{a, b} {
		if read(t, filepath.Join(dir, "both.txt")) != "new" || read(t, filepath.Join(dir, "only-a.txt")) != "a" ||
			read(t, filepath.Join(dir, "only-b.txt")) != "b" || read(t, filepath.Join(dir, "many", "5.txt")) != "5" {
			t.Errorf("%s doesn't hold the merge", dir)
		}
	}
	if _, err := ts.Get(ctx, got.LastChangeID); err != nil {
		t.Errorf("the merge isn't in History: %v", err)
	}
	merge := got.LastChangeID

	// Nothing changed: the run is dropped from History.
	got = f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultSynced || got.LastChangeID != merge {
		t.Errorf("an idle run: %+v", got)
	}
	active, _ := ts.Active(ctx)
	ended, err := ts.Ended(ctx, transfers.EndedQuery{Limit: 50})
	testutil.Must(t, err)
	if len(active) != 0 || len(ended.Items) != 1 || ended.Items[0].ID != merge {
		t.Errorf("History holds %d running and %+v", len(active), ended.Items)
	}

	// Changes go both ways, and a file changed on both sides keeps both versions.
	write(t, filepath.Join(a, "new-a.txt"), "na", time.Now())
	testutil.Must(t, os.Remove(filepath.Join(b, "only-b.txt")))
	write(t, filepath.Join(a, "both.txt"), "from a", time.Now().Add(-10*time.Second))
	write(t, filepath.Join(b, "both.txt"), "from b", time.Now())
	got = f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultSynced || got.LastChangeID == merge {
		t.Fatalf("after changes: %+v", got)
	}
	if read(t, filepath.Join(b, "new-a.txt")) != "na" {
		t.Error("a new file wasn't copied")
	}
	if _, err := os.Stat(filepath.Join(a, "only-b.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Error("a deleted file wasn't deleted on the other side")
	}
	for _, dir := range []string{a, b} {
		entries, _ := os.ReadDir(dir)
		var versions []string
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "both.txt") {
				versions = append(versions, read(t, filepath.Join(dir, e.Name())))
			}
		}
		if len(versions) != 2 || !strings.Contains(strings.Join(versions, ","), "from a") ||
			!strings.Contains(strings.Join(versions, ","), "from b") {
			t.Errorf("%s keeps %v of the conflict", dir, versions)
		}
	}

	// More than half the files deleted in B: the watcher stops, saying B lost them.
	testutil.Must(t, os.RemoveAll(filepath.Join(b, "many")))
	testutil.Must(t, os.Remove(filepath.Join(b, "only-a.txt")))
	got = f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultFailed || got.Attention != AttentionDeletes || got.DeletedSide != SideB {
		t.Fatalf("after many deletes: %+v", got)
	}
	if _, err := ts.Get(ctx, got.LastTransferID); err != nil {
		t.Errorf("the failed run isn't in History: %v", err)
	}
	if _, err := os.Stat(filepath.Join(a, "many", "1.txt")); err != nil {
		t.Error("the safety let the deletes through")
	}
	// Resync brings them back.
	got = f.syncNow(w, f.s.Resync)
	if got.LastResult != ResultSynced || got.Attention != "" || !got.Baselined {
		t.Fatalf("after Resync: %+v", got)
	}
	if read(t, filepath.Join(b, "many", "1.txt")) != "1" {
		t.Error("Resync didn't bring the files back")
	}

	// The same deletes in A, then Force deletes them in B too.
	testutil.Must(t, os.RemoveAll(filepath.Join(a, "many")))
	testutil.Must(t, os.Remove(filepath.Join(a, "only-a.txt")))
	got = f.syncNow(w, f.s.SyncNow)
	if got.Attention != AttentionDeletes || got.DeletedSide != SideA {
		t.Fatalf("after many deletes in A: %+v", got)
	}
	got = f.syncNow(w, f.s.Force)
	if got.LastResult != ResultSynced || got.Attention != "" {
		t.Fatalf("after Force: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(b, "many", "1.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Error("Force didn't delete the files in B")
	}

	// Listings that are gone need a resync.
	testutil.Must(t, os.RemoveAll(f.s.o.Workdir))
	got = f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultFailed || got.Attention != AttentionResync {
		t.Fatalf("without listings: %+v", got)
	}
	got = f.syncNow(w, f.s.Resync)
	if got.LastResult != ResultSynced || got.Attention != "" || !got.Baselined {
		t.Fatalf("after Resync: %+v", got)
	}

	// No run told the notification targets or the desktop about its transfer. The failures all
	// came within minutes of a success, so they make one streak, and one watcher.failed.
	if n := len(f.notes.desktop()); n != 1 || f.notes.count() != 1 {
		t.Errorf("%d desktop notifications and %d watcher.failed, want one of each", n, f.notes.count())
	}
	if others := f.notes.sentOthers(); len(others) > 0 {
		t.Errorf("the targets were told %v", others)
	}
}

// Two empty folders stay quiet: bisync refuses to go on from the empty listing that the last
// merge left, so the watcher merges instead, and nothing is recorded or told. A file added later
// is copied across.
func TestEmptyFolders(t *testing.T) {
	f, ts := realFixture(t)
	ctx := context.Background()
	a, b := t.TempDir(), t.TempDir()
	w := f.save(Input{Name: "Empty", PathA: a, PathB: b})
	testutil.Eventually(t, 30*time.Second, "the first merge", func() bool { return f.get(w.ID).LastRunAt != nil })
	for range 2 {
		got := f.syncNow(w, f.s.SyncNow)
		if got.LastResult != ResultSynced || got.LastError != "" || got.Attention != "" || !got.Baselined {
			t.Fatalf("two empty folders: %+v", got)
		}
	}
	ended, err := ts.Ended(ctx, transfers.EndedQuery{Limit: 50})
	testutil.Must(t, err)
	if len(ended.Items) != 0 {
		t.Errorf("History holds %+v", ended.Items)
	}
	if f.notes.count() != 0 || len(f.notes.desktop()) != 0 || len(f.notes.sentOthers()) != 0 {
		t.Error("two empty folders notified")
	}

	write(t, filepath.Join(a, "new.txt"), "n", time.Now())
	got := f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultSynced || got.LastChangeID == "" {
		t.Fatalf("after a new file: %+v", got)
	}
	if read(t, filepath.Join(b, "new.txt")) != "n" {
		t.Error("the new file wasn't copied")
	}
}

// A folder that lost every file stops the watcher like too many deletes, with that folder.
// Force can't use bisync's force, which refuses an empty side, so it syncs the empty folder to
// the other one, and then merges: the watcher is fine again, with two empty folders.
func TestEmptiedFolder(t *testing.T) {
	f, _ := realFixture(t)
	a, b := t.TempDir(), t.TempDir()
	for _, name := range []string{"1", "2", "3"} {
		write(t, filepath.Join(a, name+".txt"), name, time.Now().Add(-time.Hour))
	}
	w := f.save(Input{Name: "Docs", PathA: a, PathB: b})
	testutil.Eventually(t, 30*time.Second, "the first merge", func() bool { return f.get(w.ID).LastRunAt != nil })
	for _, name := range []string{"1", "2", "3"} {
		testutil.Must(t, os.Remove(filepath.Join(a, name+".txt")))
	}
	got := f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultFailed || got.Attention != AttentionEmptied || got.DeletedSide != SideA {
		t.Fatalf("after emptying A: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(b, "1.txt")); err != nil {
		t.Fatal("B lost its files before the user said so")
	}
	testutil.Must(t, f.s.Force(context.Background(), w.ID))
	testutil.Eventually(t, 30*time.Second, "the force and its merge", func() bool {
		got = f.get(w.ID)
		return got.Attention == "" && got.LastResult == ResultSynced
	})
	entries, _ := os.ReadDir(b)
	if len(entries) != 0 {
		t.Errorf("B still holds %d entries", len(entries))
	}
	// Two empty folders now: quiet.
	got = f.syncNow(w, f.s.SyncNow)
	if got.LastResult != ResultSynced || got.Attention != "" || !got.Baselined {
		t.Errorf("after the force: %+v", got)
	}
}

// emptyA makes a watcher whose folder A lost every file, so that it waits for Force or Resync.
func emptyA(t *testing.T, f *fixture) (w *Watcher, a, b string) {
	t.Helper()
	a, b = t.TempDir(), t.TempDir()
	for _, name := range []string{"1", "2", "3"} {
		write(t, filepath.Join(a, name+".txt"), name, time.Now().Add(-time.Hour))
	}
	w = f.save(Input{Name: "Docs", PathA: a, PathB: b})
	testutil.Eventually(t, 30*time.Second, "the first merge", func() bool { return f.get(w.ID).LastRunAt != nil })
	for _, name := range []string{"1", "2", "3"} {
		testutil.Must(t, os.Remove(filepath.Join(a, name+".txt")))
	}
	if got := f.syncNow(w, f.s.SyncNow); got.Attention != AttentionEmptied || got.DeletedSide != SideA {
		t.Fatalf("after emptying A: %+v", got)
	}
	return w, a, b
}

// Force doesn't sync from a folder that has files again since it was found empty: that sync
// would delete the other folder's files. Nothing changes, and the watcher needs a resync, which
// merges the two folders.
func TestForceAfterTheFolderFilledAgain(t *testing.T) {
	f, _ := realFixture(t)
	w, a, b := emptyA(t, f)
	write(t, filepath.Join(a, "back.txt"), "back", time.Now())
	got := f.syncNow(w, f.s.Force)
	if got.LastResult != ResultFailed || got.Attention != AttentionResync || got.DeletedSide != "" ||
		!strings.Contains(got.LastError, "has files again") {
		t.Fatalf("after the force: %+v", got)
	}
	for _, name := range []string{"1", "2", "3"} {
		if _, err := os.Stat(filepath.Join(b, name+".txt")); err != nil {
			t.Errorf("B lost %s.txt", name)
		}
	}
	got = f.syncNow(w, f.s.Resync)
	if got.LastResult != ResultSynced || got.Attention != "" {
		t.Fatalf("after the resync: %+v", got)
	}
	if read(t, filepath.Join(b, "back.txt")) != "back" || read(t, filepath.Join(a, "1.txt")) != "1" {
		t.Error("the resync didn't merge the folders")
	}
}

// Force doesn't run when the folder that was empty can't be listed, such as a disk that isn't
// attached. The watcher still waits for Force or Resync.
func TestForceWhenTheFolderIsGone(t *testing.T) {
	f, _ := realFixture(t)
	w, a, b := emptyA(t, f)
	testutil.Must(t, os.Remove(a))
	if err := f.s.Force(context.Background(), w.ID); err == nil || !strings.Contains(err.Error(), "could not be checked") {
		t.Fatalf("Force: %v", err)
	}
	// The run checks too, for a folder that disappears between Force and the run's start.
	f.s.kick(w.ID, modeForce)
	var got *Watcher
	testutil.Eventually(t, 30*time.Second, "the force's end", func() bool {
		got = f.get(w.ID)
		return strings.Contains(got.LastError, "could not be checked")
	})
	if got.LastResult != ResultFailed || got.Attention != AttentionEmptied || got.DeletedSide != SideA {
		t.Fatalf("after the force: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(b, "1.txt")); err != nil {
		t.Error("B lost its files")
	}
}
