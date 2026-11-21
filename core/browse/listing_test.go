package browse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func testLister() (*Lister, *clock) {
	c := &clock{t: time.UnixMilli(1_700_000_000_000)}
	l := NewLister()
	l.now = c.now
	return l, c
}

// epochOf returns the generation of the (fs, dir) listing in l. An invalidation changes it.
func epochOf(l *Lister, fsName, dir string) uint64 {
	fsName, dir = Clean(fsName, dir)
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stateLocked(listingKey{fsName, dir}).gen
}

// listOf lists through l and returns the emitted rows and fetchedAt.
func listOf(t *testing.T, l *Lister, fsName, dir string, fresh bool, max int) ([]Entry, int64, error) {
	t.Helper()
	var rows []Entry
	at, err := l.List(context.Background(), fsName, dir, fresh, false, max, func(e []Entry) { rows = append(rows, e...) })
	return rows, at, err
}

func paths(rows []Entry) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Path
	}
	return out
}

func TestListingCache(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/2.txt": "22", "a/1.txt": "1", "a/sub/x": "x", "b/": ""})}
	root := AddFixture(fx)
	l, c := testLister()

	rows, at, err := listOf(t, l, root, "a", false, ListMax)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(rows); !slices.Equal(got, []string{"a/1.txt", "a/2.txt", "a/sub"}) {
		t.Fatalf("rows %v", got)
	}
	if !rows[2].IsDir || rows[1].Size != 2 || rows[1].Name != "2.txt" || rows[1].ModTime == "" {
		t.Errorf("row shape: %+v", rows)
	}
	if at != c.now().UnixMilli() || fx.Lists() != 1 {
		t.Fatalf("fetchedAt %d, %d listings", at, fx.Lists())
	}
	epoch := epochOf(l, root, "a")

	step := func(name string, d time.Duration, fresh bool, wantLists int, wantAt int64) {
		t.Helper()
		c.add(d)
		rows, got, err := listOf(t, l, root, "a", fresh, ListMax)
		if err != nil || len(rows) != 3 {
			t.Fatalf("%s: %v %v", name, paths(rows), err)
		}
		if fx.Lists() != wantLists || got != wantAt {
			t.Fatalf("%s: %d listings, fetchedAt %d; want %d, %d", name, fx.Lists(), got, wantLists, wantAt)
		}
	}
	step("fresh: served from the cache", 4*time.Minute, false, 1, at)
	if epochOf(l, root, "a") != epoch {
		t.Error("the epoch changed while the listing is fresh")
	}
	step("a refresh asks rclone", 0, true, 2, c.now().UnixMilli())
	at = c.now().UnixMilli()
	if epochOf(l, root, "a") != epoch {
		t.Error("a refresh changed the epoch")
	}
	step("still fresh after the refresh", 4*time.Minute, false, 2, at)
	c.add(time.Minute + time.Millisecond)
	step("stale: asks rclone", 0, false, 3, c.now().UnixMilli())
}

func TestListingKeep(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"})}
	root := AddFixture(fx)
	l, c := testLister()
	l.fresh = 24 * time.Hour // test only the keep rule

	for range 3 { // requested every 20 min, so it is kept
		if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil {
			t.Fatal(err)
		}
		c.add(20 * time.Minute)
	}
	c.add(9 * time.Minute) // 29 minutes since the last request
	if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil || fx.Lists() != 1 {
		t.Fatalf("kept while asked for: %d listings, %v", fx.Lists(), err)
	}
	c.add(ListingKeep)
	if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil || fx.Lists() != 2 {
		t.Fatalf("dropped after %v unasked: %d listings, %v", ListingKeep, fx.Lists(), err)
	}
	c.add(ListingKeep)
	l.tick()
	l.mu.Lock()
	n := len(l.states)
	l.mu.Unlock()
	if n != 0 {
		t.Errorf("%d listings held after the sweep", n)
	}
}

func TestAFailedListingIsNotCached(t *testing.T) {
	var fail bool
	var mu sync.Mutex
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"}), Hook: func(_ context.Context, dir string) error {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return errRefused
		}
		return nil
	}}
	root := AddFixture(fx)
	l, _ := testLister()
	mu.Lock()
	fail = true
	mu.Unlock()
	if _, _, err := listOf(t, l, root, "", false, ListMax); !errors.Is(err, errRefused) {
		t.Fatalf("err %v", err)
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	rows, _, err := listOf(t, l, root, "", false, ListMax)
	if err != nil || len(rows) != 1 || fx.Lists() != 2 {
		t.Fatalf("after a failure: %v %v, %d listings", paths(rows), err, fx.Lists())
	}
}

func TestAChangeDuringAListingIsNotCached(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"}), Hook: func(ctx context.Context, _ string) error {
		select {
		case started <- struct{}{}:
			<-release
		default:
		}
		return nil
	}}
	root := AddFixture(fx)
	l, _ := testLister()
	done := make(chan error)
	go func() {
		_, _, err := listOf(t, l, root, "a", false, ListMax)
		done <- err
	}()
	<-started
	l.InvalidatePaths(root + "a/new")
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil || fx.Lists() != 2 {
		t.Fatalf("%d listings, %v: the answer begun before the change was served", fx.Lists(), err)
	}
}

func TestTrailingSlashRetry(t *testing.T) {
	var dirs []string
	var mu sync.Mutex
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"}), Hook: func(_ context.Context, dir string) error {
		mu.Lock()
		defer mu.Unlock()
		dirs = append(dirs, dir)
		if !strings.HasSuffix(dir, "/") {
			return errRefused // this backend wants folders with a slash
		}
		return nil
	}}
	root := AddFixture(fx)
	l, _ := testLister()
	rows, _, err := listOf(t, l, root, "a", false, ListMax)
	if err != nil || !slices.Equal(paths(rows), []string{"a/1"}) {
		t.Fatalf("%v %v", paths(rows), err)
	}
	// The root is not retried, because "" has no form with a trailing slash.
	if _, _, err := listOf(t, l, root, "", false, ListMax); !errors.Is(err, errRefused) {
		t.Fatalf("root: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(dirs, []string{"a", "a/", ""}) {
		t.Errorf("asked %q", dirs)
	}
}

// TestTrailingSlashRetryKeepsTheFirstError checks that when the retry also fails, the first
// listing's error is returned rather than the retry's. S3, for example, has no folder whose name
// ends in a slash.
func TestTrailingSlashRetryKeepsTheFirstError(t *testing.T) {
	errNotFound := errors.New("directory not found")
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"}), Hook: func(_ context.Context, dir string) error {
		if strings.HasSuffix(dir, "/") {
			return errNotFound
		}
		return errRefused
	}}
	l, _ := testLister()
	if _, _, err := listOf(t, l, AddFixture(fx), "a", false, ListMax); !errors.Is(err, errRefused) || fx.Lists() != 2 {
		t.Fatalf("%d listings: %v, want the first one's error", fx.Lists(), err)
	}
}

func TestRowsAreSortedAndDeduped(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"c": "", "a": "", "b/": ""}), Dupes: true}
	root := AddFixture(fx)
	l, _ := testLister()
	rows, _, err := listOf(t, l, root, "", false, ListMax)
	if err != nil || !slices.Equal(paths(rows), []string{"a", "b", "c"}) {
		t.Fatalf("%v %v", paths(rows), err)
	}
}

func TestCleanAndTheAbsoluteRoot(t *testing.T) {
	for _, tc := range []struct{ fs, dir, wantFs, wantDir string }{
		{"r:", "a/b/", "r:", "a/b"},
		{"r:", "/a", "r:/", "a"},
		{"r:", "/", "r:/", ""},
		{"r:/", "a", "r:/", "a"},
		{":local:/", "/tmp/x", ":local:/", "tmp/x"},
		{"r:sub", "/x", "r:sub", "x"},
	} {
		gotFs, gotDir := Clean(tc.fs, tc.dir)
		if gotFs != tc.wantFs || gotDir != tc.wantDir {
			t.Errorf("Clean(%q, %q) = %q, %q", tc.fs, tc.dir, gotFs, gotDir)
		}
	}
	// The two roots are two separate listings.
	l, _ := testLister()
	if epochOf(l, "r:", "") == epochOf(l, "r:/", "") || epochOf(l, "r:", "/a") != epochOf(l, "r:/", "a/") {
		t.Error("keys: r: and r:/ must differ, r: + /a and r:/ + a/ must not")
	}
}

// memoryFiles creates n files in folder dir of a new memory bucket and returns the bucket's fs.
func memoryFiles(t *testing.T, dir string, n int) string {
	t.Helper()
	bucket := fmt.Sprintf(":memory:bkt-%s", strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")))
	ctx := context.Background()
	f, err := cache.Get(ctx, bucket)
	if err != nil {
		t.Fatal(err)
	}
	for i := range n {
		name := fmt.Sprintf("%s/file-%03d", dir, i)
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader("x")), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	return bucket
}

func TestAPagedListingStopsAtTheCap(t *testing.T) {
	bucket := memoryFiles(t, "d", 250)
	for _, tc := range []struct {
		name         string
		listP        bool
		max          int
		wantRows     int
		wantTranches int
	}{
		{"paged, under the cap", true, ListMax, 250, 3},
		{"paged, stopped in the page the cap is reached in", true, 150, 150, 2},
		{"paged, stopped at a page's end", true, 100, 100, 1},
		{"not paged: cut after the one answer", false, 150, 150, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := &Fixture{Inner: bucket, ListP: tc.listP}
			root := AddFixture(fx)
			l, _ := testLister()
			rows, _, err := listOf(t, l, root, "d", false, tc.max)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != tc.wantRows || fx.Tranches() != tc.wantTranches || fx.Lists() != 1 {
				t.Fatalf("%d rows, %d pages, %d listings", len(rows), fx.Tranches(), fx.Lists())
			}
			// The cached copy serves the same cap, sorted as a whole. A bigger cap asks rclone again.
			again, _, _ := listOf(t, l, root, "d", false, tc.max)
			if len(again) != tc.wantRows || fx.Lists() != 1 {
				t.Fatalf("again: %d rows, %d listings", len(again), fx.Lists())
			}
			if !slices.IsSortedFunc(again, func(a, b Entry) int { return strings.Compare(a.Path, b.Path) }) {
				t.Error("the cached rows are not sorted")
			}
			if tc.wantRows < 250 {
				if more, _, _ := listOf(t, l, root, "d", false, ListMax); len(more) != 250 || fx.Lists() != 2 {
					t.Fatalf("a bigger cap: %d rows, %d listings", len(more), fx.Lists())
				}
			}
		})
	}
}

func TestInvalidation(t *testing.T) {
	keys := [][2]string{
		{"mem:", ""}, {"mem:", "a"}, {"mem:", "a/b"}, {"mem:", "a/b/c"}, {"mem:", "ab"},
		{"mem:/", "a"}, {"mem,x=y:", "a"}, {"other:", "a"}, {"other:", "a/z"}, {"other:", "z"},
		{":local:/", "tmp/x"}, {":local:/", "tmp/xy"},
	}
	for _, tc := range []struct {
		name string
		do   func(l *Lister)
		want []string // "fs|dir" of the listings invalidated
	}{
		{"an entry changed: its folder, itself and below", func(l *Lister) { l.InvalidatePaths("mem:a/b") },
			[]string{"mem:|a", "mem:|a/b", "mem:|a/b/c", "mem,x=y:|a"}},
		{"an entry at the root", func(l *Lister) { l.InvalidatePaths("mem:a") },
			[]string{"mem:|", "mem:|a", "mem:|a/b", "mem:|a/b/c", "mem,x=y:|a"}},
		{"a folder, below and above it", func(l *Lister) { l.InvalidateFolders("mem:a/") },
			[]string{"mem:|", "mem:|a", "mem:|a/b", "mem:|a/b/c", "mem,x=y:|a"}},
		{"a new folder deep down: every folder above it", func(l *Lister) { l.InvalidateFolders("mem:a/b/new/deep") },
			[]string{"mem:|", "mem:|a", "mem:|a/b", "mem,x=y:|a"}},
		{"the absolute root is another place", func(l *Lister) { l.InvalidatePaths("mem:/a/f.txt") },
			[]string{"mem:/|a"}},
		{"remotes", func(l *Lister) { l.InvalidateRemotes([]string{"mem"}) },
			[]string{"mem:|", "mem:|a", "mem:|a/b", "mem:|a/b/c", "mem:|ab", "mem:/|a", "mem,x=y:|a"}},
		{"a copy ended: its destination", func(l *Lister) { l.TransferEnded("copy", []string{"mem:ab/f.txt"}, "other:a/") },
			[]string{"other:|a", "other:|a/z"}},
		{"a move ended: its sources too", func(l *Lister) { l.TransferEnded("move", []string{"mem:ab/f.txt"}, "other:z") },
			[]string{"mem:|ab", "other:|z"}},
		{"a download ended: the entry it wrote and its folder", func(l *Lister) { l.TransferEnded("download", []string{"https://x/y"}, "other:a/z") },
			[]string{"other:|a", "other:|a/z"}},
		{"a purge ended", func(l *Lister) { l.TransferEnded("purge", []string{"mem:a/b"}, "") },
			[]string{"mem:|a", "mem:|a/b", "mem:|a/b/c", "mem,x=y:|a"}},
		{"a bisync ended: both its paths", func(l *Lister) { l.TransferEnded("bisync", []string{"mem:a/b"}, "other:a") },
			[]string{"mem:|", "mem:|a", "mem:|a/b", "mem:|a/b/c", "mem,x=y:|a", "other:|a", "other:|a/z"}},
		{"a local path", func(l *Lister) { l.InvalidatePaths("/tmp/x/new") },
			[]string{":local:/|tmp/x"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l, _ := testLister()
			before := map[string]uint64{}
			for _, k := range keys {
				before[k[0]+"|"+k[1]] = epochOf(l, k[0], k[1])
			}
			tc.do(l)
			var got []string
			for _, k := range keys {
				if epochOf(l, k[0], k[1]) != before[k[0]+"|"+k[1]] {
					got = append(got, k[0]+"|"+k[1])
				}
			}
			slices.Sort(got)
			want := slices.Sorted(slices.Values(tc.want))
			if !slices.Equal(got, want) {
				t.Errorf("invalidated %q, want %q", got, want)
			}
		})
	}
}

func TestInvalidationDropsTheCachedRows(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a/1": "1"})}
	root := AddFixture(fx)
	l, _ := testLister()
	for i, invalidate := range []func(){
		func() { l.InvalidatePaths(root + "a/1") },
		func() { l.InvalidateFolders(root) },
	} {
		if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil {
			t.Fatal(err)
		}
		invalidate()
		if _, _, err := listOf(t, l, root, "a", false, ListMax); err != nil || fx.Lists() != i+2 {
			t.Fatalf("case %d: %d listings, %v", i, fx.Lists(), err)
		}
	}
}
