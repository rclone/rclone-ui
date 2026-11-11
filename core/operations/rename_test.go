package operations

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	rcops "github.com/rclone/rclone/fs/operations"
	rcsync "github.com/rclone/rclone/fs/sync"

	"github.com/rclone/rclone-ui/core/rclone"
)

// misreported returns a temp folder on a store that ignores case, and a remote that opens it but
// reports that it doesn't ignore case (the local backend with case_sensitive=true). This is how
// sftp to a Mac, or smb with case_insensitive=false, looks to rclone. The test is skipped where
// the temp folder is case-sensitive (Linux).
func misreported(t *testing.T) (dir, remote string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir = filepath.ToSlash(dir)
	write(t, dir+"/probe", "")
	if !exists(dir + "/PROBE") {
		t.Skip("the temp folder keeps case apart")
	}
	if err := os.Remove(dir + "/probe"); err != nil {
		t.Fatal(err)
	}
	return dir, ":local,case_sensitive=true:" + dir
}

// names returns a folder's entries as the store spells them.
func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// content returns a file's content, or "" when it can't be read.
func content(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// inJob runs fn on the Fs of remote, in an rclone job.
func inJob(t *testing.T, remote string, fn func(ctx context.Context, f fs.Fs) error) error {
	t.Helper()
	_, err := rclone.Run(context.Background(), rclone.CallOpts{}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, remote)
		if err != nil {
			return err
		}
		return fn(ctx, f)
	})
	return err
}

// On a store that claims to be case-sensitive but isn't, rclone's own MoveFile finds the file
// as its own destination and deletes it. That is why a change of case never uses MoveFile. If
// rclone fixes this, keep the MoveFileCaseSafe route, because a store's flag can't be trusted,
// and change this test.
func TestPlainMoveFileDeletesOnAMisreportedStore(t *testing.T) {
	dir, remote := misreported(t)
	write(t, dir+"/a.txt", "data")
	err := inJob(t, remote, func(ctx context.Context, f fs.Fs) error {
		return rcops.MoveFile(ctx, f, f, "A.txt", "a.txt")
	})
	if err != nil {
		t.Fatalf("rclone's MoveFile now fails: %v", err)
	}
	if got := names(t, dir); len(got) != 0 {
		t.Fatalf("rclone's MoveFile no longer deletes the file: %v", got)
	}
}

// On a store that misreports its case handling, a change of case loses no data. This covers a
// file, a folder with a subfolder, and the folder of a retried file.
func TestCaseOnlyOnAMisreportedStore(t *testing.T) {
	dir, remote := misreported(t)

	t.Run("a file", func(t *testing.T) {
		write(t, dir+"/file/a.txt", "a")
		err := inJob(t, remote+"/file", func(ctx context.Context, f fs.Fs) error {
			return MoveFileCaseSafe(ctx, f, f, "A.txt", "a.txt")
		})
		if err != nil || !slices.Equal(names(t, dir+"/file"), []string{"A.txt"}) || content(dir+"/file/A.txt") != "a" {
			t.Fatalf("%v: %v", err, names(t, dir+"/file"))
		}
	})

	t.Run("a folder", func(t *testing.T) {
		write(t, dir+"/dir/foo/x.txt", "x")
		write(t, dir+"/dir/foo/sub/y.txt", "y")
		p := buildOf(t, func() (Plan, error) {
			return buildRename([]RenameItem{{Path: remote + "/dir/foo", IsDir: true, NewName: "Foo"}})
		})
		rec, err := runPlan(t, p)
		if err != nil || rec.Steps()[0].Err != nil {
			t.Fatalf("%v %v", err, rec.Steps()[0].Err)
		}
		if got := names(t, dir+"/dir"); !slices.Equal(got, []string{"Foo"}) {
			t.Errorf("the folder holds %v", got)
		}
		if content(dir+"/dir/Foo/x.txt") != "x" || content(dir+"/dir/Foo/sub/y.txt") != "y" {
			t.Errorf("files lost: %v %v", names(t, dir+"/dir/Foo"), names(t, dir+"/dir/Foo/sub"))
		}
	})

	t.Run("a retried file of a folder", func(t *testing.T) {
		write(t, dir+"/retry/photos/a.txt", "a")
		write(t, dir+"/retry/photos/b.txt", "b")
		// A retry keeps the plan's config. This plan has none, so only the case-safe route keeps
		// the file.
		rec, err := runPlan(t, Plan{V: PlanVersion, Steps: []Step{{
			Op: OpMoveFile, Src: remote + "/retry/photos/", SrcRemote: "a.txt",
			Dst: remote + "/retry/Photos/", DstRemote: "a.txt",
		}}})
		if err != nil || rec.Steps()[0].Err != nil {
			t.Fatalf("%v %v", err, rec.Steps()[0].Err)
		}
		if content(dir+"/retry/photos/a.txt") != "a" || content(dir+"/retry/photos/b.txt") != "b" {
			t.Errorf("files lost: %v", names(t, dir+"/retry/photos"))
		}
	})
}

// On a backend without a directory move (memory), a change of case of a folder moves file by
// file, twice. Every file ends up under the new spelling, and nothing is left under the old one
// or the temporary one.
func TestCaseOnlyFolderFileByFile(t *testing.T) {
	const bucket = "mem:caseonly"
	files := map[string]string{"x.txt": "x", "sub/y.txt": "y"}
	err := inJob(t, bucket, func(ctx context.Context, f fs.Fs) error {
		for name, data := range files {
			if _, err := rcops.Rcat(ctx, f, "foo/"+name, io.NopCloser(strings.NewReader(data)), time.Now(), nil); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	p := buildOf(t, func() (Plan, error) {
		return buildRename([]RenameItem{{Path: bucket + "/foo", IsDir: true, NewName: "Foo"}})
	})
	if rec, err := runPlan(t, p); err != nil || rec.Steps()[0].Err != nil {
		t.Fatalf("%v %v", err, rec.Steps()[0].Err)
	}
	err = inJob(t, bucket, func(ctx context.Context, f fs.Fs) error {
		entries, err := f.List(ctx, "")
		if err != nil {
			return err
		}
		if len(entries) != 1 || entries[0].Remote() != "Foo" {
			t.Errorf("the bucket holds %v", entries)
		}
		for name, data := range files {
			o, err := f.NewObject(ctx, "Foo/"+name)
			if err != nil {
				return err
			}
			if o.Size() != int64(len(data)) {
				t.Errorf("%s is %d bytes", name, o.Size())
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// failSecondMove makes the second move of the next case-only step fail once, before it moves
// anything. The step stops with its folder under the temporary name.
func failSecondMove(t *testing.T) {
	t.Helper()
	var calls atomic.Int32
	moveDir = func(ctx context.Context, fdst, fsrc fs.Fs, deleteEmptySrcDirs, copyEmptySrcDirs bool) error {
		if calls.Add(1) == 2 {
			return errors.New("the second move failed")
		}
		return rcsync.MoveDir(ctx, fdst, fsrc, deleteEmptySrcDirs, copyEmptySrcDirs)
	}
	t.Cleanup(func() { moveDir = rcsync.MoveDir })
}

// A retry finishes a change of case of a folder that failed between its two moves. It finds the
// folder under the temporary name and makes only the second move. When the failed step left
// files in both places, the retry finishes the first move and then makes the second.
func TestCaseOnlyFolderRetried(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir = filepath.ToSlash(dir)
	renameOf := func(folder string) Plan {
		return buildOf(t, func() (Plan, error) {
			return buildRename([]RenameItem{{Path: folder + "/foo", IsDir: true, NewName: "Foo"}})
		})
	}
	renamed := func(folder string) {
		t.Helper()
		if got := names(t, folder); !slices.Equal(got, []string{"Foo"}) {
			t.Errorf("the folder holds %v", got)
		}
		if content(folder+"/Foo/x.txt") != "x" || content(folder+"/Foo/sub/y.txt") != "y" {
			t.Errorf("files lost: %v %v", names(t, folder+"/Foo"), names(t, folder+"/Foo/sub"))
		}
	}

	t.Run("between the moves", func(t *testing.T) {
		folder := dir + "/between"
		write(t, folder+"/foo/x.txt", "x")
		write(t, folder+"/foo/sub/y.txt", "y")
		p := renameOf(folder)
		failSecondMove(t)
		rec, err := runPlan(t, p)
		if err != nil || rec.Steps()[0].Err == nil {
			t.Fatalf("the first run: %v %v", err, rec.Steps()[0].Err)
		}
		tmp := path.Base(caseOnlyTemp(p.Steps[0]))
		if got := names(t, folder); !slices.Equal(got, []string{tmp}) {
			t.Fatalf("after the first run the folder holds %v, want %s", got, tmp)
		}
		if rec, err := runPlan(t, p); err != nil || rec.Steps()[0].Err != nil {
			t.Fatalf("the retry: %v %v", err, rec.Steps()[0].Err)
		}
		renamed(folder)
	})

	t.Run("during the first move", func(t *testing.T) {
		folder := dir + "/during"
		p := renameOf(folder)
		tmp := path.Base(caseOnlyTemp(p.Steps[0]))
		write(t, folder+"/foo/x.txt", "x")
		write(t, folder+"/"+tmp+"/sub/y.txt", "y")
		if rec, err := runPlan(t, p); err != nil || rec.Steps()[0].Err != nil {
			t.Fatalf("the retry: %v %v", err, rec.Steps()[0].Err)
		}
		renamed(folder)
	})
}
