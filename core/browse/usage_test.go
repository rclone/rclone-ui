package browse

import (
	"context"
	"fmt"
	"io"
	"maps"
	"path"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"
	"github.com/rclone/rclone/fstest/mockdir"

	"github.com/rclone/rclone-ui/core/location"
)

// file is a listed file: only its path and size are read.
type file struct {
	fs.Object
	remote string
	size   int64
}

func (f file) Remote() string { return f.remote }
func (f file) Size() int64    { return f.size }

// entries makes a listing: a name ending in / is a folder, and any other gets its size from
// sizes, or 1.
func entries(sizes map[string]int64, names ...string) fs.DirEntries {
	var out fs.DirEntries
	for _, n := range names {
		if rel, ok := strings.CutSuffix(n, "/"); ok {
			out = append(out, mockdir.New(rel))
			continue
		}
		size, ok := sizes[n]
		if !ok {
			size = 1
		}
		out = append(out, file{remote: n, size: size})
	}
	return out
}

var memRoot = location.Fs{Name: "mem", Config: "mem", Folder: true}

// names returns the rows' names in order, with their bytes.
func names(level UsageLevel) []string {
	var out []string
	for _, r := range level.Rows {
		out = append(out, r.Name)
	}
	return out
}

func level(t *testing.T, tree *UsageTree, rel string, by UsageSort) UsageLevel {
	t.Helper()
	l, ok := tree.Level(memRoot, rel, by, 0)
	if !ok {
		t.Fatalf("no folder %q", rel)
	}
	return l
}

// TestUsageTreeAddsUp checks the totals of a tree built from entries in any order, where some
// files arrive before their folders and some folders never arrive at all, as on a bucket.
func TestUsageTreeAddsUp(t *testing.T) {
	tree := NewUsageTree()
	tree.add(entries(map[string]int64{"a/b/c.txt": 10, "a/d.txt": 5, "a/b/doc": -1}, "a/b/c.txt", "e", "f/", "a/d.txt"))
	tree.add(entries(map[string]int64{"a/b/doc": -1}, "a/", "a/b/", "a/b/doc", ".hidden/x"))

	got := tree.Count()
	want := UsageCount{Bytes: 17, Files: 5, Folders: 4, Unknown: 1}
	if got != want {
		t.Fatalf("count %+v, want %+v", got, want)
	}
	root := level(t, tree, "", BySize)
	if !slices.Equal(names(root), []string{"a", ".hidden", "e", "f"}) {
		t.Fatalf("root rows %q", names(root))
	}
	a := root.Rows[0]
	if a.Bytes != 15 || a.Files != 3 || a.Folders != 1 || a.Unknown != 1 || !a.IsDir || a.Rel != "a" || a.Path != "mem:a" {
		t.Fatalf("row a %+v", a)
	}
	inA := level(t, tree, "a", BySize)
	if !slices.Equal(names(inA), []string{"b", "d.txt"}) || inA.Total.Bytes != 15 {
		t.Fatalf("a's rows %q, total %+v", names(inA), inA.Total)
	}
	if d := inA.Rows[1]; d.IsDir || d.Bytes != 5 || d.Files != 1 || d.Path != "mem:a/d.txt" {
		t.Fatalf("row d.txt %+v", d)
	}
	doc := level(t, tree, "a/b", BySize).Rows[1]
	if doc.Name != "doc" || doc.Unknown != 1 || doc.Bytes != 0 {
		t.Fatalf("a file of unknown size: %+v", doc)
	}
	if _, ok := tree.Level(memRoot, "a/missing", BySize, 0); ok {
		t.Fatal("a folder the tree hasn't got was found")
	}
}

func TestUsageTreeSorts(t *testing.T) {
	tree := NewUsageTree()
	tree.add(entries(map[string]int64{"big": 100, "many/1": 1, "many/2": 1, "many/3": 1, "Mid": 50, "same-a": 7, "same-b": 7},
		"big", "many/1", "many/2", "many/3", "Mid", "same-b", "same-a"))
	for by, want := range map[UsageSort][]string{
		BySize:  {"big", "Mid", "same-a", "same-b", "many"},
		ByName:  {"big", "many", "Mid", "same-a", "same-b"},
		ByFiles: {"many", "big", "Mid", "same-a", "same-b"},
	} {
		if got := names(level(t, tree, "", by)); !slices.Equal(got, want) {
			t.Errorf("by %s: %q, want %q", by, got, want)
		}
	}
	l, _ := tree.Level(memRoot, "", BySize, 2)
	if !slices.Equal(names(l), []string{"big", "Mid"}) || l.More != 3 {
		t.Fatalf("the first 2 rows: %q, more %d", names(l), l.More)
	}
}

// TestUsageTreeFirstRows checks that the first rows of a folder with many entries are the same as
// the start of all its rows, in each order.
func TestUsageTreeFirstRows(t *testing.T) {
	tree := NewUsageTree()
	sizes := map[string]int64{}
	var all []string
	for i := range 300 {
		dir := fmt.Sprintf("d%03d/", i)
		for j := range i % 4 {
			name := fmt.Sprintf("%sf%d", dir, j)
			sizes[name] = int64((i * 7919) % 50)
			all = append(all, name)
		}
		all = append(all, dir)
		file := fmt.Sprintf("F%03d", i)
		sizes[file] = int64((i * 104729) % 60)
		all = append(all, file)
	}
	tree.add(entries(sizes, all...))
	for _, by := range []UsageSort{BySize, ByName, ByFiles} {
		every := level(t, tree, "", by)
		first, _ := tree.Level(memRoot, "", by, 50)
		if len(every.Rows) != 600 || every.More != 0 {
			t.Fatalf("by %s: %d rows, more %d", by, len(every.Rows), every.More)
		}
		if !slices.Equal(names(first), names(every)[:50]) || first.More != 550 {
			t.Errorf("by %s: the first 50 rows\n got %q\nwant %q, more %d", by, names(first), names(every)[:50], first.More)
		}
		if !reflect.DeepEqual(first.Rows, every.Rows[:50]) {
			t.Errorf("by %s: the first rows differ from the start of all rows", by)
		}
	}
}

// TestUsageTreeKeepsTheLargestFiles checks that a folder keeps its largest files by name, and
// counts the others as its smaller files, with the totals exact.
func TestUsageTreeKeepsTheLargestFiles(t *testing.T) {
	tree := NewUsageTree()
	tree.keep = 3
	sizes := map[string]int64{}
	var all []string
	for i := range 10 {
		n := "d/" + string(rune('a'+i))
		sizes[n] = int64(i + 1)
		all = append(all, n)
	}
	rand := []int{4, 9, 0, 7, 2, 5, 8, 1, 6, 3} // a fixed order that isn't sorted
	for _, i := range rand {
		tree.add(entries(sizes, all[i]))
	}
	d := level(t, tree, "d", BySize)
	if !slices.Equal(names(d), []string{"j", "i", "h"}) {
		t.Fatalf("kept %q, want the 3 largest", names(d))
	}
	if d.Rest != (UsageRest{Files: 7, Bytes: 28}) || d.Total.Bytes != 55 || d.Total.Files != 10 {
		t.Fatalf("rest %+v, total %+v", d.Rest, d.Total)
	}
}

// TestUsageTreeStaysInItsBudget checks that a scan past its budget lets go of the smallest files
// of every folder, and keeps counting them.
func TestUsageTreeStaysInItsBudget(t *testing.T) {
	tree := NewUsageTree()
	tree.budget = 4
	sizes := map[string]int64{"a/1": 10000, "b/2": 5000, "a/3": 100, "c/4": 200, "b/5": 8000, "c/6": 9000, "a/7": 300}
	for _, n := range []string{"a/1", "b/2", "a/3", "c/4", "b/5", "c/6", "a/7"} {
		tree.add(entries(sizes, n))
	}
	if tree.kept != 4 || tree.floor != usageFloor {
		t.Fatalf("kept %d with floor %d, want 4 with %d", tree.kept, tree.floor, usageFloor)
	}
	a := level(t, tree, "a", BySize)
	if !slices.Equal(names(a), []string{"1"}) || a.Rest != (UsageRest{Files: 2, Bytes: 400}) {
		t.Fatalf("a keeps %q, rest %+v", names(a), a.Rest)
	}
	if c := tree.Count(); c.Bytes != 32600 || c.Files != 7 {
		t.Fatalf("count %+v", c)
	}
}

func TestUsageTreeForgets(t *testing.T) {
	tree := NewUsageTree()
	tree.add(entries(map[string]int64{"a/b/c": 10, "a/b/d/e": 20, "a/f": 5, "g": 1}, "a/b/c", "a/b/d/e", "a/f", "g"))
	tree.unread("a/b/d/x")
	if tree.Forget("a/b", false) || !tree.Forget("a/b", true) {
		t.Fatal("a/b wasn't forgotten")
	}
	if c := tree.Count(); c.Bytes != 6 || c.Files != 2 || c.Folders != 1 || c.Unread != 0 {
		t.Fatalf("count after forgetting a/b: %+v", c)
	}
	if tree.kept != 2 {
		t.Fatalf("kept %d, want 2", tree.kept)
	}
	if tree.Forget("a/f", true) || !tree.Forget("a/f", false) || tree.Forget("a/f", false) || tree.Forget("nothing/here", false) {
		t.Fatal("forgetting a file once, then again, then one the tree hasn't got")
	}
	if c := tree.Count(); c.Bytes != 1 || c.Files != 1 {
		t.Fatalf("count after forgetting a/f: %+v", c)
	}
	// New entries still go to the right place after the folder remembered last went away.
	tree.add(entries(nil, "a/b/new"))
	if c := tree.Count(); c.Files != 2 || c.Folders != 2 {
		t.Fatalf("count after a new entry: %+v", c)
	}
}

// A bucket can hold a file and a folder of the same name. Forgetting one leaves the other.
func TestUsageTreeForgetsAFileOrAFolderOfTheSameName(t *testing.T) {
	tree := NewUsageTree()
	tree.add(entries(map[string]int64{"logs": 10, "logs/a": 20, "logs/b": 30}, "logs", "logs/a", "logs/b"))
	if !tree.Forget("logs", false) {
		t.Fatal("the file logs wasn't forgotten")
	}
	if c := tree.Count(); c.Bytes != 50 || c.Files != 2 || c.Folders != 1 {
		t.Fatalf("count after forgetting the file: %+v", c)
	}
	if !tree.Forget("logs", true) {
		t.Fatal("the folder logs wasn't forgotten")
	}
	if c := tree.Count(); c.Bytes != 0 || c.Files != 0 || c.Folders != 0 {
		t.Fatalf("count after forgetting the folder: %+v", c)
	}
}

func TestUsageTreeMarksWhatItCouldNotRead(t *testing.T) {
	tree := NewUsageTree()
	tree.add(entries(nil, "a/b/", "a/c/"))
	tree.unread("a/b")
	tree.unread("a/b")
	if c := tree.Count(); c.Unread != 1 {
		t.Fatalf("unread %d, want 1", c.Unread)
	}
	if a := level(t, tree, "", BySize).Rows[0]; a.Unread || a.UnreadBelow != 1 {
		t.Fatalf("row a %+v", a)
	}
	if b := level(t, tree, "a", ByName).Rows[0]; b.Name != "b" || !b.Unread {
		t.Fatalf("row b %+v", b)
	}
}

func TestUsageTreeStopsAtItsMostFolders(t *testing.T) {
	tree := NewUsageTree()
	tree.maxFolders = 2
	tree.add(entries(nil, "a/"))
	if tree.full() {
		t.Fatal("full after 1 folder")
	}
	tree.add(entries(nil, "b/x"))
	if !tree.full() || !tree.Count().Capped {
		t.Fatal("not full after 2 folders")
	}
}

// TestScanUsageWalksFolderByFolder scans a local tree through a backend without ListR. A folder
// that can't be listed is marked, a skipped folder isn't listed at all, and dot-files count.
func TestScanUsageWalksFolderByFolder(t *testing.T) {
	var mu sync.Mutex
	var listed []string
	fx := &Fixture{Inner: MakeTree(t, map[string]string{
		"a/one":      "0123456789",
		"a/sub/two":  "01234567890123456789",
		".dot/three": "abc",
		"bad/four":   "abcd",
		"skip/five":  "abcde",
		"six":        "abcdef",
	}), Hook: func(ctx context.Context, dir string) error {
		mu.Lock()
		listed = append(listed, dir)
		mu.Unlock()
		if dir == "bad" {
			return errRefused
		}
		return nil
	}}
	f, err := cache.Get(context.Background(), AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	tree := NewUsageTree()
	if err := scanUsage(context.Background(), f, map[string]bool{"skip": true}, tree); err != nil {
		t.Fatal(err)
	}
	if c := tree.Count(); c.Bytes != 39 || c.Files != 4 || c.Folders != 4 || c.Unread != 1 {
		t.Fatalf("count %+v", c)
	}
	if slices.Contains(listed, "skip") {
		t.Fatal("the skipped folder was listed")
	}
	if got := names(level(t, tree, "", BySize)); !slices.Equal(got, []string{"a", "six", ".dot", "bad"}) {
		t.Fatalf("root rows %q", got)
	}
}

func TestScanUsageFailsWhenTheRootCannotBeListed(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a": "x"}), Hook: func(ctx context.Context, dir string) error {
		return errRefused
	}}
	f, err := cache.Get(context.Background(), AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	if err := scanUsage(context.Background(), f, nil, NewUsageTree()); err == nil || !strings.Contains(err.Error(), errRefused.Error()) {
		t.Fatalf("err %v, want the root's error", err)
	}
}

func TestScanUsageThroughTheBackendsListR(t *testing.T) {
	ctx := context.Background()
	f, err := cache.Get(ctx, ":memory:usage-listr")
	if err != nil {
		t.Fatal(err)
	}
	if f.Features().ListR == nil {
		t.Fatal("memory has no ListR any more: this test needs a backend with one")
	}
	for name, text := range map[string]string{"bucket/x/1": "aa", "bucket/x/y/2": "bbb", "other/3": "c"} {
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader(text)), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	tree := NewUsageTree()
	if err := scanUsage(ctx, f, nil, tree); err != nil {
		t.Fatal(err)
	}
	if c := tree.Count(); c.Bytes != 6 || c.Files != 3 || c.Folders != 4 {
		t.Fatalf("count %+v", c)
	}
}

// TestScanUsageAfterAFailedTreeListing scans through a backend that lists the whole tree at once,
// where one folder can't be listed. The scan walks the tree again, marks that folder, and counts
// the rest once.
func TestScanUsageAfterAFailedTreeListing(t *testing.T) {
	fx := &Fixture{ListR: true, Inner: MakeTree(t, map[string]string{
		"a/one": "0123456789", "bad/two": "01", "c/three": "012", "four": "0123",
	}), Hook: func(ctx context.Context, dir string) error {
		if dir == "bad" {
			return errRefused
		}
		return nil
	}}
	f, err := cache.Get(context.Background(), AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	if f.Features().ListR == nil {
		t.Fatal("the fixture has no ListR")
	}
	tree := NewUsageTree()
	if err := scanUsage(context.Background(), f, nil, tree); err != nil {
		t.Fatal(err)
	}
	if c := tree.Count(); c.Bytes != 17 || c.Files != 3 || c.Folders != 3 || c.Unread != 1 {
		t.Fatalf("count %+v", c)
	}
}

// TestScanUsageWhenAWorkerDies checks that a scan ends when a listing panics, as a fatal rclone
// error does. That folder is marked unread, and the others are counted.
func TestScanUsageWhenAWorkerDies(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{
		"a/one": "0123456789", "bad/two": "01", "c/three": "012", "c/d/five": "01234", "four": "0123",
	}), Hook: func(ctx context.Context, dir string) error {
		if dir == "bad" {
			panic("a fatal error")
		}
		return nil
	}}
	f, err := cache.Get(context.Background(), AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	tree := NewUsageTree()
	ended := make(chan error, 1)
	go func() { ended <- scanUsage(context.Background(), f, nil, tree) }()
	select {
	case err := <-ended:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the scan hangs")
	}
	if c := tree.Count(); c.Bytes != 22 || c.Files != 4 || c.Unread != 1 {
		t.Fatalf("count %+v", c)
	}

	// With one worker, nobody reads the folders left: the scan ends with the panic's error.
	ctx, ci := fs.AddConfig(context.Background())
	ci.Checkers = 1
	fx.Hook = func(ctx context.Context, dir string) error {
		if dir == "" {
			panic("a fatal error")
		}
		return nil
	}
	f, err = cache.Get(ctx, AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	if err := scanUsage(ctx, f, nil, NewUsageTree()); err == nil || !strings.Contains(err.Error(), "a fatal error") {
		t.Fatalf("err %v, want the panic's", err)
	}
}

// TestScanUsageStops checks that a scan stops promptly when its context ends, and keeps what
// it found.
func TestScanUsageStops(t *testing.T) {
	entered := make(chan struct{})
	var once sync.Once
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"fast": "12345", "slow/x": "1"}), Hook: func(ctx context.Context, dir string) error {
		if dir == "slow" {
			once.Do(func() { close(entered) })
			return Sleep(ctx, time.Minute)
		}
		return nil
	}}
	f, err := cache.Get(context.Background(), AddFixture(fx))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-entered
		cancel()
	}()
	tree := NewUsageTree()
	start := time.Now()
	_ = scanUsage(ctx, f, nil, tree)
	if time.Since(start) > 5*time.Second {
		t.Fatalf("stopped after %v", time.Since(start))
	}
	if c := tree.Count(); c.Bytes != 5 || c.Files != 1 || c.Unread != 0 {
		t.Fatalf("count %+v: want what was found before the stop, with nothing marked unread", c)
	}
}

func TestDiskRoot(t *testing.T) {
	mac := []string{"/", darwinData, "/System/Volumes/VM", "/dev", "/Volumes/Backup", "/Users/me/mnt/gdrive"}
	linux := []string{"/", "/home", "/proc", "/home/me/fuse"}
	for _, c := range []struct {
		goos, full, root string
		skip             []string
	}{
		{"darwin", "/Users/me/Documents", "/", []string{"System/Volumes/Data", "System/Volumes/VM", "dev", "Volumes/Backup", "Users/me/mnt/gdrive"}},
		{"darwin", darwinData + "/Users/me", "/", []string{"System/Volumes/Data", "System/Volumes/VM", "dev", "Volumes/Backup", "Users/me/mnt/gdrive"}},
		{"darwin", "/Volumes/Backup/photos", "/Volumes/Backup", nil},
		{"darwin", "/Volumes/BackupOld", "/", []string{"System/Volumes/Data", "System/Volumes/VM", "dev", "Volumes/Backup", "Users/me/mnt/gdrive"}},
		{"linux", "/home/me", "/home", []string{"me/fuse"}},
		{"linux", "/etc", "/", []string{"home", "proc", "home/me/fuse"}},
		{"linux", "/opt", "/", []string{"home", "proc", "home/me/fuse"}},
	} {
		points := linux
		if c.goos == "darwin" {
			points = mac
		}
		root, skip := diskRoot(c.goos, c.full, points)
		if root != c.root || !slices.Equal(slices.Sorted(maps.Keys(skip)), slices.Sorted(slices.Values(c.skip))) {
			t.Errorf("%s %s: root %s, skip %v, want %s, %v", c.goos, c.full, root, slices.Sorted(maps.Keys(skip)), c.root, c.skip)
		}
	}
	if root, _ := diskRoot("linux", "/anything", nil); root != "/" {
		t.Errorf("without a mount table: %s", root)
	}
}

func TestUsageRootOf(t *testing.T) {
	for _, c := range []struct{ path, root string }{
		{"mem:a/b", "mem:"},
		{"mem,x=1:a", "mem,x=1:"},
		{"sftp:/var/log", "sftp:/"},
		{"sftp:docs", "sftp:"},
	} {
		at, err := usageRootOf(c.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := at.Entry(""); got != c.root || at.Local || len(at.Skip) != 0 {
			t.Errorf("%s: root %s (local %v), want %s", c.path, got, at.Local, c.root)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	dir := MakeTree(t, map[string]string{"x/": ""})
	parent := path.Dir(dir)
	at, err := usageRootOf(path.Join(dir, "x"), func() ([]string, error) { return []string{"/", parent, dir + "/x/mnt"}, nil })
	if err != nil {
		t.Fatal(err)
	}
	if !at.Local || at.Entry("") != parent+"/" || !at.Skip[path.Base(dir)+"/x/mnt"] {
		t.Fatalf("root %s, local %v, skip %v", at.Entry(""), at.Local, at.Skip)
	}
	if at.Entry("a/b") != parent+"/a/b" {
		t.Fatalf("an entry's path: %s", at.Entry("a/b"))
	}
	if _, err := usageRootOf("relative/path", nil); err == nil {
		t.Fatal("a relative path was accepted")
	}
}

// TestWalkQueueTakesTurns checks that the walk takes one folder from each top folder in turn, and
// reads the folders below each one in the order they were found.
func TestWalkQueueTakesTurns(t *testing.T) {
	q := newWalkQueue()
	if q.pop() != "" || q.len() != 0 {
		t.Fatal("the walk starts at the root")
	}
	for _, dir := range []string{"a", "b", "c"} {
		q.push(dir)
	}
	var got []string
	pop := func() {
		dir := q.pop()
		got = append(got, dir)
		// Each top folder holds two folders, and a/1 one more.
		switch dir {
		case "a", "b", "c":
			q.push(dir + "/1")
			q.push(dir + "/2")
		case "a/1":
			q.push("a/1/x")
		}
	}
	for q.len() > 0 {
		pop()
	}
	want := []string{"a", "b", "c", "a/1", "b/1", "c/1", "a/2", "b/2", "c/2", "a/1/x"}
	if !slices.Equal(got, want) {
		t.Fatalf("order %q, want %q", got, want)
	}
}
