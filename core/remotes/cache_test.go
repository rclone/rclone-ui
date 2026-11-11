package remotes

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/sync"
	"github.com/rclone/rclone/lib/batcher"

	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/rclone"
)

// batchingFs is a memory Fs whose uploads commit through rclone's lib/batcher, as Dropbox's do
// with batch_mode=sync. Its Shutdown shuts the batcher down, as Dropbox's does, so an upload
// after that fails.
type batchingFs struct {
	fs.Fs
	b          *batcher.Batcher[string, string]
	name, root string
}

func (f *batchingFs) Name() string { return f.name }
func (f *batchingFs) Root() string { return f.root }

// batchPuts counts the uploads. atPut runs at the third one, in the middle of the copy.
var (
	batchPuts atomic.Int32
	atPut     atomic.Value // func()
)

func (f *batchingFs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	o, err := f.Fs.Put(ctx, in, src, options...)
	if err != nil {
		return nil, err
	}
	if batchPuts.Add(1) == 3 {
		if fn, ok := atPut.Load().(func()); ok && fn != nil {
			fn()
		}
	}
	if _, err := f.b.Commit(ctx, src.Remote(), src.Remote()); err != nil {
		return nil, err
	}
	return o, nil
}

func (f *batchingFs) Shutdown(context.Context) error {
	f.b.Shutdown()
	return nil
}

func init() {
	fs.Register(&fs.RegInfo{
		Name: "rcuibatching", Description: "a memory Fs committing through lib/batcher (tests)",
		NewFs: func(ctx context.Context, name, root string, _ configmap.Mapper) (fs.Fs, error) {
			base, err := fs.NewFs(ctx, ":memory:"+name+"/"+root)
			if err != nil {
				return nil, err
			}
			f := &batchingFs{Fs: base, name: name, root: root}
			f.b, err = batcher.New(ctx, f, func(context.Context, []string, []string, []error) error { return nil },
				batcher.Options{Mode: "sync", MaxBatchSize: 1000, DefaultTimeoutSync: 10 * time.Millisecond,
					DefaultTimeoutAsync: time.Second, DefaultBatchSizeAsync: 10})
			return f, err
		},
	})
}

// TestUnrelatedChangeKeepsInUseFs checks that a change to another remote during a copy leaves
// the copy's target Fs running. Clearing rclone's whole cache would shut its batcher down.
func TestUnrelatedChangeKeepsInUseFs(t *testing.T) {
	s, _ := setup(t, "[up]\ntype = rcuibatching\n\n[other]\ntype = memory\n")
	src := t.TempDir()
	for i := range 20 {
		if err := os.WriteFile(filepath.Join(src, fmt.Sprintf("f%02d", i)), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	batchPuts.Store(0)
	atPut.Store(func() { s.Changed([]string{"other"}) })
	t.Cleanup(func() { atPut.Store(func() {}) })

	ctx, ci := fs.AddConfig(context.Background())
	ci.Transfers = 1
	_, err := rclone.Run(ctx, rclone.CallOpts{}, func(ctx context.Context) error {
		srcF, err := cache.Get(ctx, src)
		if err != nil {
			return err
		}
		// Use a new folder for each run. The memory backend keeps an earlier run's files, which
		// would leave this run nothing to upload.
		dstF, err := cache.Get(ctx, "up:"+t.Name()+"/"+ids.New())
		if err != nil {
			return err
		}
		return sync.CopyDir(ctx, dstF, srcF, false)
	})
	if n := batchPuts.Load(); err != nil || n != 20 {
		t.Fatalf("the copy while another remote changed: %d puts, %v", n, err)
	}
}

// TestChangeClearsTheRemoteAndItsWrappers checks that a change to a remote drops its cached Fs
// and those of the remotes built on it, and keeps the others.
func TestChangeClearsTheRemoteAndItsWrappers(t *testing.T) {
	s, _ := setup(t, "[base]\ntype = memory\n\n[al]\ntype = alias\nremote = base:x\n\n[other]\ntype = memory\n")
	ctx := context.Background()
	get := func(name string) fs.Fs {
		t.Helper()
		f, err := cache.Get(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	base, al, other := get("base:"), get("al:"), get("other:")
	s.Changed([]string{"base"})
	if get("base:") == base {
		t.Error("base: is the same Fs after its change")
	}
	if get("al:") == al {
		t.Error("the alias over base: is the same Fs after base's change")
	}
	if get("other:") != other {
		t.Error("other: was dropped by a change to base")
	}
}
