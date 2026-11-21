package browse

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/backend/overview"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Every test shares one Init, as the app does. The remotes are in memory.
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

// MakeTree writes files under a new temporary folder and returns its real path. files maps a
// slash-separated path to its content, and a path ending in / is an empty folder.
func MakeTree(t testing.TB, files map[string]string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for rel, text := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if rel[len(rel)-1] == '/' {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// Fixture sets how the test backend behaves. The `:browsetest,id=<n>:<path>` root returned by
// AddFixture lists the Fs at Inner/<path> through the test backend. Hook runs before every List
// or ListP of dir, for example to add a delay or a failure. With ListP set, the backend is paged.
// With ListR set, it lists a whole tree at once, and stops at the first folder that fails. With
// Dupes set, every List reports each entry twice.
type Fixture struct {
	Inner string
	ListP bool
	ListR bool
	Dupes bool
	Hook  func(ctx context.Context, dir string) error

	lists, tranches, running, most atomic.Int32
	mu                             sync.Mutex
	groups                         []string
}

// Lists returns how many List or ListP calls were made. Most returns the largest number that
// ran at the same time. Tranches returns how many pages a ListP delivered.
func (fx *Fixture) Lists() int    { return int(fx.lists.Load()) }
func (fx *Fixture) Most() int     { return int(fx.most.Load()) }
func (fx *Fixture) Running() int  { return int(fx.running.Load()) }
func (fx *Fixture) Tranches() int { return int(fx.tranches.Load()) }

// Groups returns the stats groups that the listings ran in.
func (fx *Fixture) Groups() []string {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]string(nil), fx.groups...)
}

var (
	fixturesMu sync.Mutex
	fixtures   = map[string]*Fixture{}
	fixtureSeq int
)

// AddFixture returns the root of fx as an fs string.
func AddFixture(fx *Fixture) string {
	fixturesMu.Lock()
	defer fixturesMu.Unlock()
	fixtureSeq++
	id := fmt.Sprintf("f%d", fixtureSeq)
	fixtures[id] = fx
	return ":browsetest,id=" + id + ":"
}

// Sleep waits for d or until ctx ends, like a request to a throttled backend.
func Sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-time.After(d):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func init() {
	fs.Register(&fs.RegInfo{
		Name:        "browsetest",
		Description: "browse's test backend",
		NewFs:       newTestFs,
		Options:     []fs.Option{{Name: "id", Help: "The fixture.", Required: true}},
		Overview:    new(overview.BackendConfig),
	})
}

// testFs wraps the inner Fs under its own name and root. rclone's fs cache stores an Fs under
// fs.ConfigString(f), so with the inner Fs's name and root the cache would return the inner Fs
// in place of this one.
type testFs struct {
	fs.Fs
	name, root string
	fx         *Fixture
	features   *fs.Features
}

// testFsP is a paged backend, because it has ListP.
type testFsP struct{ *testFs }

// testFsR lists a whole tree at once, because it has ListR.
type testFsR struct{ *testFs }

func newTestFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	id, _ := m.Get("id")
	fixturesMu.Lock()
	fx := fixtures[id]
	fixturesMu.Unlock()
	if fx == nil {
		return nil, fmt.Errorf("no fixture %q", id)
	}
	inner, err := fs.NewFs(ctx, fspath.JoinRootPath(fx.Inner, root))
	if inner == nil {
		return nil, err
	}
	t := &testFs{Fs: inner, name: name, root: root, fx: fx}
	var f fs.Fs = t
	switch {
	case fx.ListP:
		f = &testFsP{t}
	case fx.ListR:
		f = &testFsR{t}
	}
	t.features = (&fs.Features{}).Fill(ctx, f)
	return f, err // fs.ErrorIsFile passes through
}

func (f *testFs) Features() *fs.Features { return f.features }
func (f *testFs) Name() string           { return f.name }
func (f *testFs) Root() string           { return f.root }
func (f *testFs) String() string         { return f.name + ":" + f.root }

func (f *testFs) List(ctx context.Context, dir string) (fs.DirEntries, error) {
	if err := f.fx.enter(ctx, dir); err != nil {
		return nil, err
	}
	defer f.fx.running.Add(-1)
	entries, err := f.Fs.List(ctx, dir)
	if f.fx.Dupes {
		entries = append(entries, entries...)
	}
	return entries, err
}

// ListP splits the inner listing into pages. It uses the inner backend's own pages when that
// backend is paged (the memory backend uses 100 entries each), and pages of 100 otherwise.
func (f *testFsP) ListP(ctx context.Context, dir string, callback fs.ListRCallback) error {
	if err := f.fx.enter(ctx, dir); err != nil {
		return err
	}
	defer f.fx.running.Add(-1)
	page := func(entries fs.DirEntries) error {
		f.fx.tranches.Add(1)
		return callback(entries)
	}
	if listP := f.Fs.Features().ListP; listP != nil {
		return listP(ctx, dir, page)
	}
	entries, err := f.Fs.List(ctx, dir)
	if err != nil {
		return err
	}
	for len(entries) > 0 {
		n := min(100, len(entries))
		if err := page(entries[:n]); err != nil {
			return err
		}
		entries = entries[n:]
	}
	return nil
}

// ListR lists each folder below dir through List, so the hook runs for each, and sends each
// listing on. It stops at the first error, as a bucket's listing does.
func (f *testFsR) ListR(ctx context.Context, dir string, callback fs.ListRCallback) error {
	entries, err := f.List(ctx, dir)
	if err != nil {
		return err
	}
	if err := callback(entries); err != nil {
		return err
	}
	for _, e := range entries {
		if d, ok := e.(fs.Directory); ok {
			if err := f.ListR(ctx, d.Remote(), callback); err != nil {
				return err
			}
		}
	}
	return nil
}

// enter counts a listing and runs the hook. On success, the caller must decrement running.
func (fx *Fixture) enter(ctx context.Context, dir string) error {
	fx.lists.Add(1)
	if g, ok := accounting.StatsGroupFromContext(ctx); ok {
		fx.mu.Lock()
		fx.groups = append(fx.groups, g)
		fx.mu.Unlock()
	}
	n := fx.running.Add(1)
	for {
		most := fx.most.Load()
		if n <= most || fx.most.CompareAndSwap(most, n) {
			break
		}
	}
	if fx.Hook != nil {
		if err := fx.Hook(ctx, dir); err != nil {
			fx.running.Add(-1)
			return err
		}
	}
	return nil
}

var errRefused = errors.New("the backend refused this folder")
