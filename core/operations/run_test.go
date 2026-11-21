package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/object"
	rcops "github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/rclone"
)

// runPlan runs a plan the way the transfer service does, as a job in a stats group of its own,
// and waits for it. It returns the record and the job's error.
func runPlan(t *testing.T, p Plan) (*Record, error) {
	t.Helper()
	if err := p.Check(); err != nil {
		t.Fatalf("%+v: %v", p, err)
	}
	rec := NewRecord(p)
	group := rclone.UIGroup("test", strings.ReplaceAll(t.Name(), "/", "-"))
	t.Cleanup(func() { rclone.DeleteGroup(context.Background(), group) })
	_, err := rclone.Run(context.Background(), rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		return p.Run(ctx, "/opt/rcui/rcui", rec)
	})
	return rec, err
}

// write creates a file, along with any missing folders.
func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// stepErrors returns the error of each step in a record, or "" for a step without one.
func stepErrors(rec *Record) []string {
	var out []string
	for _, s := range rec.Steps() {
		e := ""
		if s.Err != nil {
			e = s.Err.Error()
		}
		out = append(out, e)
	}
	return out
}

// A copy of a folder and a file is built from a page's form and run in-process. Every step ends,
// and the record names each step's Fs the way rclone names it in a finished file's snapshot.
func TestRunCopy(t *testing.T) {
	src, dst := filepath.ToSlash(t.TempDir()), filepath.ToSlash(t.TempDir())
	write(t, src+"/photos/a.jpg", "aa")
	write(t, src+"/photos/sub/b.jpg", "bbb")
	write(t, src+"/one.txt", "1")
	p := buildOf(t, func() (Plan, error) {
		return buildCopy(CopyArgs{Sources: []string{src + "/photos", src + "/one.txt"}, Destination: dst}, settings{},
			Kinds{src + "/photos": KindFolder, src + "/one.txt": KindFile})
	})
	rec, err := runPlan(t, p)
	if err != nil || !reflect.DeepEqual(stepErrors(rec), []string{"", ""}) {
		t.Fatalf("%v %q", err, stepErrors(rec))
	}
	for _, f := range []string{"photos/a.jpg", "photos/sub/b.jpg", "one.txt"} {
		if !exists(filepath.Join(dst, f)) {
			t.Errorf("%s not copied", f)
		}
	}
	// A file's step opens the root that its path is split at, which on Windows is its drive.
	steps := rec.Steps()
	if steps[0].SrcFs != localFs(src+"/photos") || steps[0].DstFs != localFs(dst+"/photos") ||
		steps[1].SrcFs != localFs(filepath.VolumeName(src)+"/") || !steps[1].Ended {
		t.Errorf("record %+v", steps)
	}
}

// localFs returns the name that rclone gives the local Fs of a full path, written with `/`. On
// Windows rclone opens a local path in its long form, and names the Fs by it (`//?/C:/x`).
func localFs(path string) string {
	if runtime.GOOS == "windows" {
		return ":local://?/" + path
	}
	return ":local:" + path
}

// This covers a move of a file and of a folder, a rename of a folder and of a file (from the
// Browser), a sync that deletes what the source no longer has, a delete with a filter, and a
// purge.
func TestRunOperations(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/m/f.txt", "f")
	write(t, dir+"/m/folder/x.txt", "x")
	write(t, dir+"/r/old/in.txt", "in")
	write(t, dir+"/r/old.txt", "o")
	write(t, dir+"/s/src/keep.txt", "k")
	write(t, dir+"/s/dst/stale.txt", "s")
	write(t, dir+"/d/a.tmp", "t")
	write(t, dir+"/d/a.txt", "t")
	write(t, dir+"/p/deep/x.txt", "x")

	move := buildOf(t, func() (Plan, error) {
		return buildMove(MoveArgs{Sources: []string{dir + "/m/f.txt", dir + "/m/folder"}, Destination: dir + "/m/to"}, settings{},
			Kinds{dir + "/m/folder": KindFolder})
	})
	rename := buildOf(t, func() (Plan, error) {
		return buildRename([]RenameItem{{Path: dir + "/r/old", IsDir: true, NewName: "new"}, {Path: dir + "/r/old.txt", NewName: "new.txt"}})
	})
	sync := buildOf(t, func() (Plan, error) {
		return buildSync(SyncArgs{Source: dir + "/s/src", Destination: dir + "/s/dst"}, settings{}, Kinds{dir + "/s/src": KindFolder})
	})
	del := buildOf(t, func() (Plan, error) {
		s := mustSettings(t, "delete", groups("filter", `{"include": "*.tmp"}`))
		return buildDelete(DeleteArgs{Sources: []string{dir + "/d"}}, s, Kinds{dir + "/d": KindFolder})
	})
	purge := buildOf(t, func() (Plan, error) {
		return buildPurge(PurgeArgs{Sources: []string{dir + "/p/deep"}}, settings{}, Kinds{dir + "/p/deep": KindFolder})
	})
	for name, p := range map[string]Plan{"move": move, "rename": rename, "sync": sync, "delete": del, "purge": purge} {
		if rec, err := runPlan(t, p); err != nil || strings.Join(stepErrors(rec), "") != "" {
			t.Errorf("%s: %v %q", name, err, stepErrors(rec))
		}
	}
	for path, want := range map[string]bool{
		"m/f.txt": false, "m/to/f.txt": true, "m/folder": false, "m/to/folder/x.txt": true,
		"r/old": false, "r/new/in.txt": true, "r/old.txt": false, "r/new.txt": true,
		"s/dst/keep.txt": true, "s/dst/stale.txt": false,
		"d/a.tmp": false, "d/a.txt": true,
		"p/deep": false, "p": true,
	} {
		if exists(dir+"/"+path) != want {
			t.Errorf("%s exists: %v, want %v", path, !want, want)
		}
	}
}

// A folder moved together with its own subfolder is a single move. The subfolder goes with its
// parent, so its files are not copied twice, and they are not split between two moves that run
// at the same time.
func TestNestedFolderSourcesMoveOnce(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	for i := range 200 {
		write(t, fmt.Sprintf("%s/a/b/f%03d.txt", dir, i), "x")
	}
	p := buildOf(t, func() (Plan, error) {
		return buildMove(MoveArgs{Sources: []string{dir + "/a", dir + "/a/b"}, Destination: dir + "/x"}, settings{},
			Kinds{dir + "/a": KindFolder, dir + "/a/b": KindFolder})
	})
	if len(p.Steps) != 1 {
		t.Fatalf("steps %+v, want the parent's move alone", p.Steps)
	}
	if rec, err := runPlan(t, p); err != nil || stepErrors(rec)[0] != "" {
		t.Fatalf("%v %q", err, stepErrors(rec))
	}
	moved, _ := os.ReadDir(dir + "/x/a/b")
	if len(moved) != 200 || exists(dir+"/x/b") || exists(dir+"/a") {
		t.Errorf("%d files under x/a/b, x/b there %v, a there %v", len(moved), exists(dir+"/x/b"), exists(dir+"/a"))
	}
}

// A dry run changes nothing, including a bisync's dry run, which with its own switch set doesn't
// record any listings as done. A per-remote override reaches the backend through the connection
// string.
func TestRunDryRunAndOverrides(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/src/a.txt", "a")
	copyPlan := buildOf(t, func() (Plan, error) {
		return buildCopy(CopyArgs{Sources: []string{dir + "/src"}, Destination: dir + "/dst"}, settings{}, Kinds{dir + "/src": KindFolder})
	}).WithDryRun()
	if rec, err := runPlan(t, copyPlan); err != nil || stepErrors(rec)[0] != "" || exists(dir+"/dst") {
		t.Errorf("a dry copy: %v %q, wrote %v", err, stepErrors(rec), exists(dir+"/dst"))
	}

	write(t, dir+"/two/b.txt", "b")
	bisync := buildOf(t, func() (Plan, error) {
		return buildBisync(BisyncArgs{Source: dir + "/src", Destination: dir + "/two",
			Options: groups("outer", `{"resync": true, "maxDelete": 50, "resyncMode": "newer"}`)},
			settings{}, Kinds{dir + "/src": KindFolder})
	}).WithDryRun()
	// Run it the way a resume or a retry does, read back from what the ledger stores.
	raw, err := json.Marshal(bisync)
	if err != nil {
		t.Fatal(err)
	}
	if bisync, err = ParsePlan(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := runPlan(t, bisync); err != nil {
		t.Errorf("a dry bisync: %v", err)
	}
	if exists(dir+"/two/a.txt") || exists(dir+"/src/b.txt") {
		t.Error("a dry bisync wrote")
	}

	// A bisync of two folders that have no baseline yet fails with rclone's reason, which
	// IsFirstRun reads, so that the Bisync page can offer a resync. Once a resync sets the
	// baseline, a bisync runs.
	first := func(outer string) Plan {
		return buildOf(t, func() (Plan, error) {
			return buildBisync(BisyncArgs{Source: dir + "/src", Destination: dir + "/two",
				Options: groups("outer", outer)}, settings{}, Kinds{dir + "/src": KindFolder})
		})
	}
	if _, err := runPlan(t, first(`{}`)); err == nil || !IsFirstRun(err.Error()) {
		t.Errorf("a first bisync: %v", err)
	}
	if _, err := runPlan(t, first(`{"resync": true}`)); err != nil {
		t.Errorf("a resync: %v", err)
	}
	if _, err := runPlan(t, first(`{}`)); err != nil || !exists(dir+"/two/a.txt") {
		t.Errorf("a bisync after the resync: %v", err)
	}

	if runtime.GOOS == "windows" {
		return // creating a symbolic link needs a privilege on Windows
	}
	write(t, dir+"/target.txt", "linked")
	if err := os.Symlink(dir+"/target.txt", dir+"/src/link.txt"); err != nil {
		t.Fatal(err)
	}
	s := mustSettings(t, "copy", groups("remotes", `{":local": {"copy_links": true}}`))
	followed := buildOf(t, func() (Plan, error) {
		return buildCopy(CopyArgs{Sources: []string{dir + "/src"}, Destination: dir + "/out"}, s, Kinds{dir + "/src": KindFolder})
	})
	if !strings.HasPrefix(followed.Steps[0].Src, ":local,copy_links='true':") {
		t.Fatalf("no override in %q", followed.Steps[0].Src)
	}
	if rec, err := runPlan(t, followed); err != nil || stepErrors(rec)[0] != "" {
		t.Fatalf("%v %q", err, stepErrors(rec))
	}
	if b, err := os.ReadFile(dir + "/out/src/link.txt"); err != nil || string(b) != "linked" {
		t.Errorf("the link was not followed: %q %v", b, err)
	}
}

// In a batch, each step fails on its own and the job doesn't fail. A whole sync fails with its
// step's error. An option that rclone refuses fails the job before any step runs.
func TestRunFailures(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/ok.txt", "ok")
	batch := Plan{V: 1, Steps: []Step{
		{Op: OpCopyFile, Src: dir, SrcRemote: "missing.txt", Dst: dir + "/out", DstRemote: "missing.txt"},
		{Op: OpCopyFile, Src: dir, SrcRemote: "ok.txt", Dst: dir + "/out", DstRemote: "ok.txt"},
		{Op: OpCleanup, Src: dir},
	}}
	rec, err := runPlan(t, batch)
	errs := stepErrors(rec)
	if err != nil || !strings.Contains(errs[0], "not found") || errs[1] != "" || errs[2] == "" || !exists(dir+"/out/ok.txt") {
		t.Errorf("batch: %v %q", err, errs)
	}
	whole := Plan{V: 1, Steps: []Step{{Op: OpSync, Src: dir + "/nothing", Dst: dir + "/out2"}}}
	if rec, err := runPlan(t, whole); err == nil || !strings.Contains(err.Error(), "directory not found") || rec.Steps()[0].Err != err {
		t.Errorf("whole: %v", err)
	}
	refused := Plan{V: 1, Steps: []Step{{Op: OpDelete, Src: dir}}, Filter: Options{"max_size": "big"}}
	if err := refused.Run(context.Background(), "", nil); err == nil || !strings.Contains(err.Error(), "max_size") || !exists(dir+"/ok.txt") {
		t.Errorf("refused: %v", err)
	}
}

// rclone's logger records a sync's failed file as soon as it fails. The stats group keeps only
// the last finished files, so a sync that checks a thousand unchanged files would push the
// failure out before anything reads it. The failure is named the same way the snapshots name it.
func TestSyncFailuresAreLogged(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("a file without permissions is readable here")
	}
	src, dst := filepath.ToSlash(t.TempDir()), filepath.ToSlash(t.TempDir())
	unchanged := time.Now().Add(-time.Hour)
	for i := range 1000 {
		for _, d := range []string{src, dst} {
			p := fmt.Sprintf("%s/z%04d.txt", d, i)
			write(t, p, "same")
			if err := os.Chtimes(p, unchanged, unchanged); err != nil {
				t.Fatal(err)
			}
		}
	}
	write(t, src+"/aaa.txt", "locked")
	if err := os.Chmod(src+"/aaa.txt", 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(src+"/aaa.txt", 0o600) })
	p := buildOf(t, func() (Plan, error) {
		return buildSync(SyncArgs{Source: src, Destination: dst}, settings{}, Kinds{src: KindFolder})
	})

	ctx := context.Background()
	group := rclone.UIGroup("test", "sync-failures")
	stats := accounting.StatsGroup(ctx, group)
	stats.SetMaxCompletedTransfers(50)
	defer rclone.DeleteGroup(ctx, group)
	rec := NewRecord(p)
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		return p.Run(ctx, "", rec)
	})
	if err == nil || stats.GetErrors() != 1 {
		t.Fatalf("the sync: %v, %d errors", err, stats.GetErrors())
	}
	for _, snap := range stats.Transferred() {
		if snap.Name == "aaa.txt" {
			t.Fatalf("the snapshots still hold the failure (%d of them): nothing to show", len(stats.Transferred()))
		}
	}
	failures, n := rec.Failures()
	if len(failures) != 1 || n != 1 {
		t.Fatalf("failures %+v (%d)", failures, n)
	}
	f, step := failures[0], rec.Steps()[0]
	if f.Name != "aaa.txt" || f.SrcFs != step.SrcFs || f.DstFs != step.DstFs || f.Err == "" || f.Size != 6 || f.At.IsZero() {
		t.Errorf("failure %+v, step %+v", f, step)
	}
}

// When a sync fails more files than the ledger keeps, the record holds the first MaxFailures in
// the order they failed, and counts all of them.
func TestRecordKeepsTheFirstFailures(t *testing.T) {
	ctx := context.Background()
	f, err := fs.NewFs(ctx, ":memory:failures")
	if err != nil {
		t.Fatal(err)
	}
	rec := NewRecord(Plan{V: 1, Steps: []Step{{Op: OpSync, Src: ":memory:failures", Dst: ":memory:out"}}})
	logger := rec.syncLogger(0)
	n := 3*MaxFailures + 7
	for i := range n {
		o := object.NewStaticObjectInfo(fmt.Sprintf("f%05d", i), time.Now(), 1, true, nil, f)
		logger(ctx, rcops.TransferError, o, nil, errors.New("denied"))
	}
	logger(ctx, rcops.Differ, object.NewStaticObjectInfo("same", time.Now(), 1, true, nil, f), nil, nil) // no failure
	kept, all := rec.Failures()
	if len(kept) != MaxFailures || cap(rec.failed) > 2*MaxFailures || all != n {
		t.Fatalf("kept %d (holding %d), counted %d; want %d of %d", len(kept), cap(rec.failed), all, MaxFailures, n)
	}
	if kept[0].Name != "f00000" || kept[MaxFailures-1].Name != fmt.Sprintf("f%05d", MaxFailures-1) {
		t.Errorf("not the first to fail: %s … %s", kept[0].Name, kept[MaxFailures-1].Name)
	}
}

// A download runs rclone's CopyURL into the folder, under the given file name.
func TestRunDownload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("zipped"))
	}))
	defer srv.Close()
	dir := filepath.ToSlash(t.TempDir())
	p := buildOf(t, func() (Plan, error) {
		return buildDownload(DownloadArgs{URL: srv.URL + "/x.zip", Filename: "y.zip", Destination: dir}, settings{})
	})
	if rec, err := runPlan(t, p); err != nil || stepErrors(rec)[0] != "" {
		t.Fatalf("%v %q", err, stepErrors(rec))
	}
	if b, err := os.ReadFile(dir + "/y.zip"); err != nil || string(b) != "zipped" {
		t.Errorf("downloaded %q %v", b, err)
	}
}

// Stopping the job stops every step, both running ones and ones that haven't started yet,
// because they share its context. Each step reports that it was stopped.
func TestRunStopped(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/big.bin", strings.Repeat("x", 1<<20))
	var steps []Step
	for i := range 3 {
		steps = append(steps, Step{Op: OpCopyFile, Src: dir, SrcRemote: "big.bin", Dst: ":memory:stop" + string(rune('a'+i)), DstRemote: "big.bin"})
	}
	p := Plan{V: 1, Steps: steps, Config: Options{"bwlimit_file": "20K"}, Concurrency: 1}
	rec := NewRecord(p)
	group := rclone.UIGroup("test", "stopped")
	defer rclone.DeleteGroup(context.Background(), group)
	job, err := rclone.Run(context.Background(), rclone.CallOpts{Group: group, Async: true}, func(ctx context.Context) error {
		return p.Run(ctx, "", rec)
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	job.OnFinish(func() { close(done) })
	time.Sleep(300 * time.Millisecond)
	job.Stop()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the job did not stop")
	}
	for i, s := range rec.Steps() {
		if !s.Ended || !errors.Is(s.Err, context.Canceled) && (s.Err == nil || !strings.Contains(s.Err.Error(), "context canceled")) {
			t.Errorf("step %d: %+v", i, s)
		}
	}
	if b := accounting.StatsGroup(context.Background(), group).GetBytes(); b >= 3<<20 {
		t.Errorf("%d bytes moved: not stopped", b)
	}
}

// The app's own metadata mapper runs the current executable. Another program is left unchanged.
func TestRunnableConfig(t *testing.T) {
	own := runnableConfig(Options{"metadata_mapper": []any{"metadata-map", "--drop", "x"}, "transfers": "2"}, "/opt/rcui")
	if got := own["metadata_mapper"]; !reflect.DeepEqual(got, []string{"/opt/rcui", "metadata-map", "--drop", "x"}) || own["transfers"] != "2" {
		t.Errorf("own mapper %v", own)
	}
	other := Options{"metadata_mapper": []any{"python3", "map.py"}}
	if got := runnableConfig(other, "/opt/rcui"); !reflect.DeepEqual(got, Options{"metadata_mapper": []string{"python3", "map.py"}}) {
		t.Errorf("another mapper %v", got)
	}
	if got := runnableConfig(Options{"transfers": "2"}, "/opt/rcui"); !reflect.DeepEqual(got, Options{"transfers": "2"}) {
		t.Errorf("no mapper %v", got)
	}
}

// TestAFatalRemoteIsTheStepsError checks a step whose remote has an override that makes rclone's
// HTTP client call fs.Fatalf (a client cert without its key), on the step's own goroutine. That
// step fails, but the app keeps running, and so do the other steps.
func TestAFatalRemoteIsTheStepsError(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "src", "a.txt"), "a")
	p := Plan{V: 1, Steps: []Step{
		{Op: OpCopy, Src: ":http,url='http://127.0.0.1:9/',override.client_cert='/nonexistent.pem':", Dst: filepath.Join(dir, "dst1")},
		{Op: OpCopy, Src: filepath.Join(dir, "src"), Dst: filepath.Join(dir, "dst2")},
	}, Concurrency: 2}
	rec, err := runPlan(t, p)
	if err != nil {
		t.Fatal(err)
	}
	steps := rec.Steps()
	if steps[0].Err == nil || !strings.Contains(steps[0].Err.Error(), "client-key") {
		t.Errorf("the fatal step: %v", steps[0].Err)
	}
	if steps[1].Err != nil || !exists(filepath.Join(dir, "dst2", "a.txt")) {
		t.Errorf("the other step: %v", steps[1].Err)
	}
}

// A rename's file step whose new name was taken after the rename's checks fails, and both files
// stay as they were. The other steps still run.
func TestRenameStepFailsWhenTaken(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/r/a.txt", "a")
	write(t, dir+"/r/b.txt", "taken")
	write(t, dir+"/r/c.txt", "c")
	p := buildOf(t, func() (Plan, error) {
		return buildRename([]RenameItem{{Path: dir + "/r/a.txt", NewName: "b.txt"}, {Path: dir + "/r/c.txt", NewName: "d.txt"}})
	})
	rec, _ := runPlan(t, p)
	errs := stepErrors(rec)
	if len(errs) != 2 || !strings.Contains(errs[0], `"b.txt" already exists`) || errs[1] != "" {
		t.Fatalf("step errors %q", errs)
	}
	if b, _ := os.ReadFile(dir + "/r/b.txt"); string(b) != "taken" || !exists(dir+"/r/a.txt") {
		t.Errorf("a.txt exists %v, b.txt holds %q", exists(dir+"/r/a.txt"), b)
	}
	if exists(dir+"/r/c.txt") || !exists(dir+"/r/d.txt") {
		t.Error("c.txt was not renamed")
	}
}

// A folder renamed file by file keeps its empty subfolders, and leaves no old folder behind. A
// filter turns off the backend's own folder move, as a backend without one would.
func TestRenamedFolderKeepsEmptyFolders(t *testing.T) {
	dir := filepath.ToSlash(t.TempDir())
	write(t, dir+"/r/old/in.txt", "in")
	if err := os.MkdirAll(dir+"/r/old/empty/deeper", 0o700); err != nil {
		t.Fatal(err)
	}
	p := buildOf(t, func() (Plan, error) {
		return buildRename([]RenameItem{{Path: dir + "/r/old", IsDir: true, NewName: "new"}})
	})
	p.Filter = Options{"exclude": []any{"*.nothing"}}
	if rec, err := runPlan(t, p); err != nil || strings.Join(stepErrors(rec), "") != "" {
		t.Fatalf("%v %q", err, stepErrors(rec))
	}
	for path, want := range map[string]bool{"r/new/in.txt": true, "r/new/empty/deeper": true, "r/old": false} {
		if exists(dir+"/"+path) != want {
			t.Errorf("%s exists: %v, want %v", path, !want, want)
		}
	}
}
