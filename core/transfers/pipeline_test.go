package transfers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/operations"
)

// Two folders are copied with a per-remote override and a filter. rclone names an overridden Fs
// with a hash of its overrides (`:local{AbCdE}:/…`), but every file is still matched to the step
// it came from, by the name given to the step's Fs. Files that the filter leaves out are not
// copied.
func TestFilesMatchedToSteps(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a", "one.txt"), 3)
	writeFile(t, filepath.Join(src, "a", "skip.tmp"), 3)
	writeFile(t, filepath.Join(src, "b", "two.txt"), 4)
	args := operations.CopyArgs{
		Sources: []string{filepath.Join(src, "a"), filepath.Join(src, "b")}, Destination: dst,
		Options: groupsOf("remotes", `{":local": {"no_set_modtime": true}}`, "filter", `{"exclude": "*.tmp"}`),
	}
	started, err := f.s.Start(f.ctx, Spec{Form: formOf(t, "copy", args), Origin: page})
	if err != nil {
		t.Fatal(err)
	}
	if tr := f.wait(started.ID); tr.State != StateCompleted {
		t.Fatalf("state %s %q", tr.State, tr.Error)
	}
	if _, err := os.Stat(filepath.Join(dst, "a", "skip.tmp")); err == nil {
		t.Error("the filter was not applied")
	}
	files, err := f.s.Files(context.Background(), started.ID, FilesQuery{Outcome: OutcomeTransferred})
	if err != nil || files.Total != 2 {
		t.Fatalf("files %+v %v", files, err)
	}
	for _, file := range files.Items {
		want := 0
		if file.Name == "two.txt" {
			want = 1
		}
		if !strings.Contains(file.SrcFs, "{") || file.Step == nil || *file.Step != want {
			t.Errorf("%s from %s: step %v, want %d", file.Name, file.SrcFs, file.Step, want)
		}
	}
}

// The Browser renames a folder and a file, recorded as one move. The test checks what a page
// reads once it ends. Its failure isn't shown on the desktop, because the Commander shows it.
func TestRenameTracked(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "old", "in.txt"), 2)
	writeFile(t, filepath.Join(dir, "old.txt"), 2)
	args := operations.RenameArgs{Items: []operations.RenameItem{
		{Path: filepath.Join(dir, "old"), IsDir: true, NewName: "new"},
		{Path: filepath.Join(dir, "old.txt"), NewName: "new.txt"},
		{Path: filepath.Join(dir, "gone.txt"), NewName: "x.txt"},
	}}
	started, err := f.s.Start(f.ctx, Spec{Form: formOf(t, operations.OperationRename, args), Origin: Origin{Kind: OriginCommander}})
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.Operation != "move" || tr.State != StateFailed || tr.Error != "1 of 3 operations failed" {
		t.Fatalf("rename %+v", tr)
	}
	f.settled()
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("a rename showed %+v on the desktop", got)
	}
	for _, p := range []string{"new/in.txt", "new.txt"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	ctx := context.Background()
	tracked, err := f.s.Tracked(ctx, []string{started.ID})
	if err != nil || len(tracked) != 1 || tracked[0].State != StateFailed || len(tracked[0].Files) == 0 {
		t.Errorf("tracked %+v %v", tracked, err)
	}
	// What failed, by step: the rename of a file that doesn't exist.
	r, err := f.s.Retryable(ctx, started.ID)
	if err != nil || len(r.Items) != 1 || r.Items[0].Kind != "step" || r.Items[0].Step == nil || *r.Items[0].Step != 2 ||
		!strings.HasSuffix(r.Items[0].Label, "/gone.txt") {
		t.Errorf("retryable %+v %v", r, err)
	}
}

// A bisync dry run started from the page's arguments is recorded as a dry run and completes, and
// nothing is written on either side.
func TestBisyncDryRun(t *testing.T) {
	f := newFixture(t)
	one, two := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(one, "a.txt"), 1)
	writeFile(t, filepath.Join(two, "b.txt"), 1)
	args := operations.BisyncArgs{Source: one, Destination: two,
		Options: groupsOf("outer", `{"resync": true}`)}
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: formOf(t, "bisync", args), DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateCompleted || !tr.IsDryRun {
		t.Fatalf("bisync %s %q dry %v", tr.State, tr.Error, tr.IsDryRun)
	}
	for _, p := range []string{filepath.Join(one, "b.txt"), filepath.Join(two, "a.txt")} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("a dry bisync wrote %s", p)
		}
	}
}

// A bisync from the page's arguments carries one deleted file over. sync/bisync over rc would
// otherwise allow no deletes at all, because it doesn't apply bisync's default of 50%.
func TestBisyncCarriesADelete(t *testing.T) {
	f := newFixture(t)
	one, two := t.TempDir(), t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		writeFile(t, filepath.Join(one, name), 1)
	}
	run := func(outer string) Transfer {
		t.Helper()
		args := operations.BisyncArgs{Source: one, Destination: two,
			Options: groupsOf("outer", outer)}
		started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: formOf(t, "bisync", args)})
		if err != nil {
			t.Fatal(err)
		}
		return f.wait(started.ID)
	}
	if tr := run(`{"resync": true}`); tr.State != StateCompleted {
		t.Fatalf("baseline %s %q", tr.State, tr.Error)
	}
	if err := os.Remove(filepath.Join(one, "a.txt")); err != nil {
		t.Fatal(err)
	}
	if tr := run(`{}`); tr.State != StateCompleted {
		t.Fatalf("bisync after one delete: %s %q", tr.State, tr.Error)
	}
	if _, err := os.Stat(filepath.Join(two, "a.txt")); !os.IsNotExist(err) {
		t.Errorf("the delete was not carried over: %v", err)
	}
}

// A transfer that a newer build recorded (with a plan and outcome from a later version, after a
// downgrade) is read-only history. It can be read, shows its own error, and has nothing to retry.
func TestNewerTransferIsHistory(t *testing.T) {
	f := newFixture(t)
	f.seed("1000-aaaaaa", 1000, map[string]any{
		"state": "failed", "error": "1 of 2 operations failed",
		"request":    `{"v":99,"steps":[{"op":"copy","src":"/a","dst":"/b"},{"op":"copy","src":"/c","dst":"/d"}]}`,
		"job_output": `{"v":99,"errors":["x",""]}`,
	})
	f.exec(`INSERT INTO transfer_files (transfer_id, outcome, src_fs, name, input, what, error)
		VALUES ('1000-aaaaaa', 'failed', '/a', 'f.txt', 0, 'transferring', 'denied')`)
	ctx := context.Background()
	d, err := f.s.Get(ctx, "1000-aaaaaa")
	if err != nil || d.Retryable != 0 || !reflect.DeepEqual(englishGeneral(d.General), []GeneralError{{Error: "1 of 2 operations failed"}}) {
		t.Errorf("detail %+v %v", d, err)
	}
	if r, err := f.s.Retryable(ctx, "1000-aaaaaa"); err != nil || len(r.Items) != 0 {
		t.Errorf("retryable %+v %v", r, err)
	}
	if tracked, err := f.s.Tracked(ctx, []string{"1000-aaaaaa"}); err != nil || len(tracked) != 1 || len(tracked[0].Files) != 1 {
		t.Errorf("tracked %+v %v", tracked, err)
	}
	if _, err := f.s.Retry(f.ctx, "1000-aaaaaa", nil); !errors.Is(err, ErrNoRetry) {
		t.Errorf("retry: %v", err)
	}
}
