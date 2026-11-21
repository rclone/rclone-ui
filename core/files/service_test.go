package files

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	rcops "github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/transfers"
)

func TestMain(m *testing.M) {
	testutil.Main(m, func(dir string) error {
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, []byte("[mem]\ntype = memory\n"), 0o600); err != nil {
			return err
		}
		_, err := rclone.Init(context.Background(), rclone.InitOptions{ConfigPath: conf, CacheDir: filepath.Join(dir, "cache")})
		return err
	})
}

type recorder struct{ paths []string }

// started is the transfer service. It keeps what was started and what was recorded as done. When
// answer is set, each start returns its result instead.
type started struct {
	ops    []rcops.Operation
	forms  []rcops.Form
	done   []transfers.DoneRequest
	answer func() (transfers.Started, error)
}

func (st *started) Start(_ context.Context, r transfers.Spec) (transfers.Started, error) {
	if st.answer != nil {
		return st.answer()
	}
	if r.Origin.Kind != transfers.OriginCommander {
		return transfers.Started{}, fmt.Errorf("started from %q", r.Origin.Kind)
	}
	st.ops = append(st.ops, r.Form.Operation)
	st.forms = append(st.forms, r.Form)
	return transfers.Started{ID: fmt.Sprintf("t%d", len(st.ops)), Seq: int64(len(st.ops))}, nil
}

func (st *started) Done(_ context.Context, r transfers.DoneRequest) (transfers.Started, error) {
	st.done = append(st.done, r)
	return transfers.Started{}, nil
}

func (r *recorder) InvalidatePaths(paths ...string) { r.paths = append(r.paths, paths...) }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestLocalActions(t *testing.T) {
	ctx := context.Background()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	sub := b.Subscribe()
	defer sub.Close()
	inv := &recorder{}
	st := &started{}
	s := New(b, inv, st)

	dir := filepath.Join(root, "new")
	if err := s.Mkdir(ctx, dir); err != nil || !exists(dir) {
		t.Fatalf("mkdir: %v", err)
	}
	var inv1 *errs.FieldError
	if err := s.Mkdir(ctx, dir); !errors.As(err, &inv1) {
		t.Errorf("mkdir over a folder: %v", err)
	}
	if ev := <-sub.C; ev.Name != bus.FilesChanged {
		t.Errorf("event %s", ev.Name)
	}

	file := filepath.Join(root, "a.txt")
	if err := s.write(ctx, file, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := s.write(ctx, filepath.Join(root, "b.txt"), []byte("b")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(ctx, file, false, "b.txt"); !errors.As(err, &inv1) || inv1.Field != "newName" {
		t.Errorf("rename onto a file: %v", err)
	}
	if _, err := s.Rename(ctx, file, false, "x/y"); !errors.As(err, &inv1) {
		t.Errorf("a name with a slash: %v", err)
	}
	moved, err := s.Rename(ctx, file, false, "c.txt")
	if err != nil || !exists(filepath.Join(root, "c.txt")) || exists(file) {
		t.Fatalf("rename: %v", err)
	}
	if moved.Path != filepath.Join(root, "c.txt") || moved.TransferID != "" {
		t.Errorf("renamed %+v", moved)
	}
	// Folders are renamed and deleted by transfers.
	if err := s.write(ctx, filepath.Join(dir, "in.txt"), []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(ctx, filepath.Join(root, "taken")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(ctx, dir, true, "taken"); !errors.As(err, &inv1) {
		t.Errorf("a folder renamed onto a folder: %v", err)
	}
	r, err := s.Rename(ctx, dir, true, "renamed")
	if err != nil || r.TransferID != "t1" || r.Path != filepath.Join(root, "renamed") {
		t.Fatalf("folder rename: %+v %v", r, err)
	}
	if started, err := s.Delete(ctx, dir, true); err != nil || started != (transfers.Started{ID: "t2", Seq: 2}) {
		t.Fatalf("folder delete: %+v %v", started, err)
	}
	if !slices.Equal(st.ops, []rcops.Operation{rcops.OperationRename, rcops.OperationDeleteFolder}) ||
		st.forms[1].DeleteFolder.Path != dir {
		t.Errorf("started %v %v", st.ops, st.forms)
	}
	if started, err := s.Delete(ctx, filepath.Join(root, "c.txt"), false); err != nil || started.ID != "" || exists(filepath.Join(root, "c.txt")) {
		t.Fatalf("file delete: %v", err)
	}
	if _, err := s.Delete(ctx, "/", true); !errors.As(err, &inv1) {
		t.Errorf("deleting a root: %v", err)
	}
	if !slices.Contains(inv.paths, filepath.Join(root, "c.txt")) {
		t.Errorf("invalidated %v", inv.paths)
	}

	// A folder transfer that failed to launch is still recorded, so its id is returned (as with
	// a batch) and the page can show why. A transfer that was never recorded returns the error.
	failing := New(b, inv, &started{answer: func() (transfers.Started, error) {
		return transfers.Started{ID: "t9", Seq: 9}, errors.New("refused at launch")
	}})
	if r, err := failing.Rename(ctx, filepath.Join(root, "taken"), true, "taken2"); err != nil || r.TransferID != "t9" {
		t.Errorf("a folder rename that failed at launch: %+v %v", r, err)
	}
	if started, err := failing.Delete(ctx, filepath.Join(root, "taken"), true); err != nil || started.ID != "t9" {
		t.Errorf("a folder delete that failed at launch: %+v %v", started, err)
	}
	unrecorded := New(b, inv, &started{answer: func() (transfers.Started, error) {
		return transfers.Started{}, errors.New("the app is shutting down")
	}})
	if _, err := unrecorded.Delete(ctx, filepath.Join(root, "taken"), true); err == nil {
		t.Error("a delete that never started answered no error")
	}
}

// IsFolder tells a file from a folder by the path alone, on a disk and in a bucket, where a
// folder is only the prefix of the files in it.
func TestIsFolder(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	s := New(bus.New(), &recorder{}, &started{})
	if err := s.Mkdir(ctx, filepath.Join(root, "dir")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(root, "file.txt"), "mem:isfolder/sub/file.txt"} {
		if err := s.write(ctx, p, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	for p, want := range map[string]bool{
		filepath.Join(root, "dir"): true, filepath.Join(root, "file.txt"): false,
		"mem:isfolder/sub": true, "mem:isfolder/sub/file.txt": false, "mem:isfolder": true,
	} {
		if got, err := s.IsFolder(ctx, p); err != nil || got != want {
			t.Errorf("%s: %v %v, want %v", p, got, err, want)
		}
	}
	for _, p := range []string{filepath.Join(root, "missing"), "mem:isfolder/missing"} {
		if _, err := s.IsFolder(ctx, p); rclone.ErrorOf(err).Code != errs.CodeNotFound {
			t.Errorf("%s: %v", p, err)
		}
	}
	var refused *errs.FieldError
	if _, err := s.IsFolder(ctx, "/"); !errors.As(err, &refused) {
		t.Errorf("a root: %v", err)
	}
}

func TestBucketLessBackendKeepsAnEmptyFolder(t *testing.T) {
	ctx := context.Background()
	s := New(bus.New(), &recorder{}, &started{})
	if err := s.Mkdir(ctx, "mem:bucket"); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(ctx, "mem:bucket/folder"); err != nil {
		t.Fatal(err)
	}
	if err := s.write(ctx, "mem:bucket/folder/.probe", []byte("")); err != nil {
		t.Fatal(err)
	}
}

func TestBatchRename(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	st := &started{}
	s := New(bus.New(), &recorder{}, st)
	for _, n := range []string{"a", "b", "c"} {
		if err := s.write(ctx, filepath.Join(root, n), []byte(n)); err != nil {
			t.Fatal(err)
		}
	}
	var inv *errs.FieldError
	if _, err := s.BatchRename(ctx, []Item{{Path: filepath.Join(root, "a"), NewName: "x"}, {Path: filepath.Join(root, "b"), NewName: "c"}}); !errors.As(err, &inv) {
		t.Fatalf("a taken target: %v", err)
	}
	if exists(filepath.Join(root, "x")) {
		t.Error("the batch ran despite the taken target")
	}
	if len(st.ops) != 0 {
		t.Error("the batch started despite the taken target")
	}
	// A bucket backend returns not-found for a folder, so the listing has to find it.
	for _, p := range []string{"mem:bucket/x/keep.txt", "mem:bucket/y.txt"} {
		if err := s.write(ctx, p, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.BatchRename(ctx, []Item{{Path: "mem:bucket/y.txt", NewName: "x"}}); !errors.As(err, &inv) {
		t.Fatalf("a file renamed onto a bucket's folder: %v", err)
	}
	if len(st.ops) != 0 {
		t.Error("the batch started despite the folder")
	}
	started, err := s.BatchRename(ctx, []Item{{Path: filepath.Join(root, "a"), NewName: "x"}, {Path: filepath.Join(root, "b"), NewName: "y"}})
	if err != nil || started != (transfers.Started{ID: "t1", Seq: 1}) || len(st.forms) != 1 || len(st.forms[0].Rename.Items) != 2 {
		t.Fatalf("%+v %v %v", started, st.forms, err)
	}
}

func TestBatchRenameDuplicates(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	st := &started{}
	s := New(bus.New(), &recorder{}, st)
	for _, p := range []string{
		filepath.Join(root, "a"), filepath.Join(root, "b"), filepath.Join(root, "in", "c"),
		"mem:dups/a", "mem:dups/b",
	} {
		if err := s.write(ctx, p, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	const (
		nfc = "\u00e9.txt"  // é as one code point
		nfd = "e\u0301.txt" // e and a combining accent
	)
	for _, tc := range []struct {
		name  string
		items []Item
		want  string
	}{
		{"one name twice", []Item{{Path: filepath.Join(root, "a"), NewName: "x.txt"}, {Path: filepath.Join(root, "b"), NewName: "x.txt"}},
			"would be the same name"},
		{"one name in two forms", []Item{{Path: filepath.Join(root, "a"), NewName: nfc}, {Path: filepath.Join(root, "b"), NewName: nfd}},
			"would be the same name"},
		{"names that differ only in case", []Item{{Path: "mem:dups/a", NewName: "x.txt"}, {Path: "mem:dups/b", NewName: "X.txt"}},
			"differ only in case"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var inv *errs.FieldError
			_, err := s.BatchRename(ctx, tc.items)
			if !errors.As(err, &inv) || !strings.Contains(inv.Message, tc.want) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
		})
	}
	if len(st.ops) != 0 {
		t.Fatalf("started %v", st.ops)
	}
	// The same name in two different folders doesn't clash.
	if _, err := s.BatchRename(ctx, []Item{{Path: filepath.Join(root, "a"), NewName: "x.txt"}, {Path: filepath.Join(root, "in", "c"), NewName: "x.txt"}}); err != nil {
		t.Fatal(err)
	}
}

// names returns the names in dir, spelled as the store spells them.
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

func TestRenameCaseOnly(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	st := &started{}
	s := New(bus.New(), &recorder{}, st)
	if err := s.write(ctx, filepath.Join(root, "a.txt"), []byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(ctx, filepath.Join(root, "dir")); err != nil {
		t.Fatal(err)
	}
	moved, err := s.Rename(ctx, filepath.Join(root, "a.txt"), false, "A.txt")
	if err != nil || moved.Path != filepath.Join(root, "A.txt") {
		t.Fatalf("%+v %v", moved, err)
	}
	if got := names(t, root); !slices.Equal(got, []string{"A.txt", "dir"}) {
		t.Errorf("the folder holds %v", got)
	}
	if b, err := os.ReadFile(filepath.Join(root, "A.txt")); err != nil || string(b) != "a" {
		t.Errorf("%q %v", b, err)
	}
	if r, err := s.Rename(ctx, filepath.Join(root, "dir"), true, "Dir"); err != nil || r.TransferID != "t1" {
		t.Fatalf("a folder: %+v %v", r, err)
	}

	// On a store that keeps both spellings, the rename is refused, because the second move would
	// replace the other file.
	for _, p := range []string{"mem:case/x.txt", "mem:case/X.txt", "mem:case/y.txt"} {
		if err := s.write(ctx, p, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	var inv *errs.FieldError
	if _, err := s.Rename(ctx, "mem:case/x.txt", false, "X.txt"); !errors.As(err, &inv) {
		t.Errorf("both spellings: %v", err)
	}
	if _, err := s.Rename(ctx, "mem:case/y.txt", false, "Y.txt"); err != nil {
		t.Fatal(err)
	}
	if err := s.write(ctx, "mem:case/y.txt", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(ctx, "mem:case/Y.txt", false, "y.txt"); !errors.As(err, &inv) {
		t.Errorf("both spellings again: %v", err)
	}
}

func TestBatchRenameCaseOnly(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	st := &started{}
	s := New(bus.New(), &recorder{}, st)
	var items []Item
	for _, n := range []string{"A.txt", "B.txt", "C.txt"} {
		if err := s.write(ctx, filepath.Join(root, n), []byte(n)); err != nil {
			t.Fatal(err)
		}
		items = append(items, Item{Path: filepath.Join(root, n), NewName: strings.ToLower(n)})
	}
	started, err := s.BatchRename(ctx, items)
	if err != nil || started.ID != "t1" || len(st.forms[0].Rename.Items) != 3 {
		t.Fatalf("%+v %v", started, err)
	}
}

// appearingFs is a memory Fs whose next lookup of the name in appearing reports it missing. This
// simulates a file that appears between a rename's check and its move.
type appearingFs struct {
	fs.Fs
	name, root string
}

var (
	appearingMu sync.Mutex
	appearing   string
)

func (f *appearingFs) Name() string { return f.name }
func (f *appearingFs) Root() string { return f.root }

func (f *appearingFs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	appearingMu.Lock()
	miss := remote == appearing
	if miss {
		appearing = ""
	}
	appearingMu.Unlock()
	if miss {
		return nil, fs.ErrorObjectNotFound
	}
	return f.Fs.NewObject(ctx, remote)
}

func init() {
	fs.Register(&fs.RegInfo{
		Name: "rcuiappearing", Description: "a memory Fs where a file appears after a lookup (tests)",
		NewFs: func(ctx context.Context, name, root string, _ configmap.Mapper) (fs.Fs, error) {
			base, err := fs.NewFs(ctx, ":memory:appearing/"+root)
			if err != nil {
				return nil, err
			}
			return &appearingFs{Fs: base, name: name, root: root}, nil
		},
	})
}

func read(t *testing.T, p string) string {
	t.Helper()
	dir, leaf := path.Split(p)
	var b []byte
	_, err := rclone.Run(context.Background(), rclone.CallOpts{}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, dir)
		if err != nil {
			return err
		}
		o, err := f.NewObject(ctx, leaf)
		if err != nil {
			return err
		}
		b, err = operations.ReadFile(ctx, o)
		return err
	})
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return string(b)
}

// TestRenameKeepsAFileThatAppeared checks that a file that appears at the new name after the
// rename's check is kept. The rename reports that the name is taken, and the source file stays
// as it was.
func TestRenameKeepsAFileThatAppeared(t *testing.T) {
	ctx := context.Background()
	s := New(bus.New(), &recorder{}, &started{})
	dir := ":rcuiappearing:" + ids.New() + "/"
	for _, n := range []string{"a.txt", "b.txt"} {
		if err := s.write(ctx, dir+n, []byte(n)); err != nil {
			t.Fatal(err)
		}
	}
	appearingMu.Lock()
	appearing = "b.txt"
	appearingMu.Unlock()
	var inv *errs.FieldError
	if _, err := s.Rename(ctx, dir+"a.txt", false, "b.txt"); !errors.As(err, &inv) || inv.Field != "newName" ||
		inv.Message != `"b.txt" already exists` {
		t.Fatalf("a rename onto a file that appeared: %v", err)
	}
	if a, b := read(t, dir+"a.txt"), read(t, dir+"b.txt"); a != "a.txt" || b != "b.txt" {
		t.Errorf("a.txt holds %q, b.txt %q", a, b)
	}
	if _, err := s.Rename(ctx, dir+"a.txt", false, "c.txt"); err != nil || read(t, dir+"c.txt") != "a.txt" {
		t.Fatalf("a rename to a free name: %v", err)
	}
}

// A single-file delete is recorded once it is done. A folder delete, which runs as a transfer, and
// a delete that fails are not recorded this way.
func TestFileDeleteIsRecorded(t *testing.T) {
	ctx := context.Background()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st := &started{}
	s := New(bus.New(), &recorder{}, st)
	file := filepath.Join(root, "a.txt")
	if err := s.write(ctx, file, []byte("a")); err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	if _, err := s.Delete(ctx, file, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Delete(ctx, file, false); err == nil {
		t.Error("deleted a missing file")
	}
	if err := s.Mkdir(ctx, filepath.Join(root, "dir")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Delete(ctx, filepath.Join(root, "dir"), true); err != nil {
		t.Fatal(err)
	}
	got := st.done
	if len(got) != 1 || got[0].Form.Operation != rcops.OperationDelete || got[0].Origin.Kind != transfers.OriginCommander ||
		!slices.Equal(got[0].Form.Delete.Sources, []string{file}) || got[0].Began.Before(before.Add(-time.Second)) {
		t.Errorf("recorded %+v", got)
	}
}

// write writes content to the file at path, replacing any file already there. Tests use it to
// lay out the files that an action then changes.
func (s *Service) write(ctx context.Context, path string, content []byte) error {
	err := at(ctx, path, "path", func(p *place) error {
		_, err := operations.Rcat(p.ctx, p.f, p.leaf, io.NopCloser(bytes.NewReader(content)), time.Now(), nil)
		return err
	})
	if err != nil {
		return err
	}
	s.changed([]string{path}, nil)
	return nil
}
