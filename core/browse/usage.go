package browse

import (
	"cmp"
	"container/heap"
	"context"
	"errors"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/walk"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Disk Usage scans a whole remote, or a whole local disk, into a tree of folders with their
// totals. The Commander's Disk Usage drawer reads it one folder at a time while the scan runs.
// The totals are always exact. The files are kept by name only as far as memory allows: each
// folder keeps its largest files, and the others count as its "smaller files".

const (
	// usageKeep is the most files that one folder keeps by name.
	usageKeep = 1000
	// usageFileBudget is the most files that a whole scan keeps by name. Past it, the smallest
	// files of every folder count as its smaller files.
	usageFileBudget = 1_000_000
	// usageFloor is the first size below which files stop being kept by name, when a scan passes
	// its budget. It doubles each time the scan passes the budget again.
	usageFloor = 4096
	// UsageFolderMax is the most folders that a scan reads. Past it the scan stops and says so.
	UsageFolderMax = 1_000_000
)

// UsageSort is the order of a folder's rows.
type UsageSort string

const (
	BySize  UsageSort = "size"  // largest first
	ByName  UsageSort = "name"  // A to Z
	ByFiles UsageSort = "files" // most files first
)

// usageTotals are the files below a folder, and their bytes. A file whose size the backend
// doesn't know counts as a file with no bytes, and also as unknown.
type usageTotals struct{ bytes, files, unknown int64 }

func (t *usageTotals) add(o usageTotals) {
	t.bytes += o.bytes
	t.files += o.files
	t.unknown += o.unknown
}

func (t *usageTotals) sub(o usageTotals) {
	t.bytes -= o.bytes
	t.files -= o.files
	t.unknown -= o.unknown
}

func fileTotals(size int64) usageTotals {
	if size < 0 {
		return usageTotals{files: 1, unknown: 1}
	}
	return usageTotals{bytes: size, files: 1}
}

// usageFile is a file kept by name. size is -1 when the backend doesn't know it.
type usageFile struct {
	name string
	size int64
}

// fileHeap is a folder's kept files, with the smallest on top, so the one to let go of when a
// larger file arrives is at hand. A file of unknown size counts as the smallest.
type fileHeap []usageFile

func (h fileHeap) Len() int           { return len(h) }
func (h fileHeap) Less(i, j int) bool { return h[i].size < h[j].size }
func (h fileHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *fileHeap) Push(x any)        { *h = append(*h, x.(usageFile)) }
func (h *fileHeap) Pop() any {
	old := *h
	f := old[len(old)-1]
	*h = old[:len(old)-1]
	return f
}

// usageNode is one folder of a scan.
type usageNode struct {
	name   string
	parent *usageNode
	dirs   map[string]*usageNode // made when the first folder inside arrives
	files  fileHeap              // the files directly inside that are kept by name
	rest   usageTotals           // the files directly inside that aren't
	total  usageTotals           // every file below, those directly inside included
	// folders is how many folders are below.
	folders int64
	// unread marks a folder that couldn't be listed, so its content isn't counted.
	unread bool
	// unreadBelow is how many folders below couldn't be listed.
	unreadBelow int64
}

// rel returns the folder's path below the scan's root, "" for the root.
func (n *usageNode) rel() string {
	var names []string
	for ; n.parent != nil; n = n.parent {
		names = append(names, n.name)
	}
	slices.Reverse(names)
	return strings.Join(names, "/")
}

// UsageTree is the result of a scan, as far as it got. It is safe to read while the scan adds to
// it.
type UsageTree struct {
	mu   sync.Mutex
	root *usageNode
	// kept is how many files the whole tree keeps by name, and floor the size below which a file
	// isn't kept.
	kept  int
	floor int64
	// The limits, which tests lower.
	keep, budget int
	maxFolders   int64
	// capped is set when the scan reached maxFolders.
	capped bool
	// at is the folder that was read last.
	at string
	// lastDir and lastNode remember the folder that the last entry went into, because the
	// entries of one listing usually share it.
	lastDir  string
	lastNode *usageNode
}

func NewUsageTree() *UsageTree {
	root := &usageNode{}
	return &UsageTree{root: root, keep: usageKeep, budget: usageFileBudget, maxFolders: UsageFolderMax, lastNode: root}
}

// node returns the folder at rel, making it and any missing folder above it. Buckets often list
// files without the folders they are in, so a file's folder may not have arrived yet.
func (t *UsageTree) node(rel string) *usageNode {
	if rel == t.lastDir && t.lastNode != nil {
		return t.lastNode
	}
	n := t.root
	if rel != "" {
		for name := range strings.SplitSeq(rel, "/") {
			n = t.child(n, name)
		}
	}
	t.lastDir, t.lastNode = rel, n
	return n
}

// child returns the folder name inside n, making it when it is new.
func (t *UsageTree) child(n *usageNode, name string) *usageNode {
	if c := n.dirs[name]; c != nil {
		return c
	}
	if n.dirs == nil {
		n.dirs = map[string]*usageNode{}
	}
	c := &usageNode{name: name, parent: n}
	n.dirs[name] = c
	for p := n; p != nil; p = p.parent {
		p.folders++
	}
	if t.root.folders >= t.maxFolders {
		t.capped = true
	}
	return c
}

// add puts a batch of entries into the tree. Each entry's path is below the scan's root.
func (t *UsageTree) add(entries fs.DirEntries) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, e := range entries {
		rel := e.Remote()
		if rel == "" {
			continue
		}
		dir, name := path.Split(rel)
		dir = strings.TrimSuffix(dir, "/")
		switch e.(type) {
		case fs.Directory:
			t.child(t.node(dir), name)
		case fs.Object:
			t.addFile(t.node(dir), name, e.Size())
		}
	}
}

// addFile counts a file in n and every folder above, and keeps it by name when it is among the
// largest of n.
func (t *UsageTree) addFile(n *usageNode, name string, size int64) {
	tt := fileTotals(size)
	for p := n; p != nil; p = p.parent {
		p.total.add(tt)
	}
	switch {
	case max(size, 0) < t.floor: // unknown sizes are kept until the floor rises
		n.rest.add(tt)
		return
	case len(n.files) < t.keep:
		heap.Push(&n.files, usageFile{name, size})
		t.kept++
	case size > n.files[0].size:
		out := heap.Pop(&n.files).(usageFile)
		n.rest.add(fileTotals(out.size))
		heap.Push(&n.files, usageFile{name, size})
	default:
		n.rest.add(tt)
		return
	}
	if t.kept > t.budget {
		t.raiseFloor()
	}
}

// raiseFloor lets go of the smallest files of every folder until the tree keeps no more than its
// budget. They then count as their folders' smaller files.
func (t *UsageTree) raiseFloor() {
	for t.kept > t.budget {
		t.floor = max(usageFloor, t.floor*2)
		t.kept = 0
		stack := []*usageNode{t.root}
		for len(stack) > 0 {
			n := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			kept := n.files[:0]
			for _, f := range n.files {
				if max(f.size, 0) >= t.floor {
					kept = append(kept, f)
				} else {
					n.rest.add(fileTotals(f.size))
				}
			}
			n.files = kept
			heap.Init(&n.files)
			t.kept += len(n.files)
			for _, c := range n.dirs {
				stack = append(stack, c)
			}
		}
	}
}

// unread marks the folder at rel as one that couldn't be listed.
func (t *UsageTree) unread(rel string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := t.node(rel)
	if n.unread {
		return
	}
	n.unread = true
	for p := n.parent; p != nil; p = p.parent {
		p.unreadBelow++
	}
}

// reset empties the tree, for a scan that starts again.
func (t *UsageTree) reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.root = &usageNode{}
	t.kept, t.floor, t.capped, t.at = 0, 0, false, ""
	t.lastDir, t.lastNode = "", t.root
}

// reading notes the folder that the scan reads now.
func (t *UsageTree) reading(rel string) {
	t.mu.Lock()
	t.at = rel
	t.mu.Unlock()
}

// full reports whether the scan reached its most folders.
func (t *UsageTree) full() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.capped
}

// UsageCount is what a scan found so far.
type UsageCount struct {
	Bytes   int64 `json:"bytes"`
	Files   int64 `json:"files"`
	Folders int64 `json:"folders"`
	// Unknown is how many files have no known size.
	Unknown int64 `json:"unknown"`
	// Unread is how many folders couldn't be listed.
	Unread int64 `json:"unread"`
	// At is the folder that was read last, below the root.
	At     string `json:"at,omitempty"`
	Capped bool   `json:"capped,omitempty"`
}

func (t *UsageTree) Count() UsageCount {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.root
	unread := r.unreadBelow
	if r.unread {
		unread++
	}
	return UsageCount{
		Bytes: r.total.bytes, Files: r.total.files, Folders: r.folders, Unknown: r.total.unknown,
		Unread: unread, At: t.at, Capped: t.capped,
	}
}

// UsageRow is one entry of a folder in a scan: a folder with everything below it, or a file.
type UsageRow struct {
	Name string `json:"name"`
	// Rel is the entry's path below the scan's root, and Path its full path, as a listing's rows
	// write it.
	Rel   string `json:"rel"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	// Bytes, Files and Folders count everything below a folder. A file counts itself as one file.
	Bytes   int64 `json:"bytes"`
	Files   int64 `json:"files"`
	Folders int64 `json:"folders"`
	// Unknown is how many of the files have no known size. For a file, it is 1 when its own size
	// is unknown.
	Unknown int64 `json:"unknown"`
	// Unread marks a folder that couldn't be listed, and UnreadBelow counts the folders below it
	// that couldn't be.
	Unread      bool  `json:"unread,omitempty"`
	UnreadBelow int64 `json:"unreadBelow,omitempty"`
}

// UsageRest is the files directly in a folder that the scan doesn't keep by name.
type UsageRest struct {
	Files   int64 `json:"files"`
	Bytes   int64 `json:"bytes"`
	Unknown int64 `json:"unknown"`
}

// UsageLevel is one folder of a scan with its rows.
type UsageLevel struct {
	// Rel is the folder's path below the scan's root, "" for the root.
	Rel string `json:"rel"`
	// Total is the folder itself, as its row in its parent shows it.
	Total UsageRow `json:"total"`
	// Rows are its folders and kept files in the asked order, at most the asked number.
	Rows []UsageRow `json:"rows"`
	// More is how many rows follow the last one returned.
	More int       `json:"more"`
	Rest UsageRest `json:"rest"`
}

// Level returns the folder at rel with its first limit rows in the order by. root writes the rows'
// full paths. It returns false when the tree has no such folder.
//
// The drawer reads a folder twice a second while the scan adds to it, under the tree's lock. So
// only the rows it returns are built: the folder's entries are ordered by their numbers, and a
// heap keeps the first limit of them.
func (t *UsageTree) Level(root location.Fs, rel string, by UsageSort, limit int) (UsageLevel, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := t.find(rel)
	if n == nil {
		return UsageLevel{}, false
	}
	total := len(n.dirs) + len(n.files)
	keep := total
	if limit > 0 && limit < total {
		keep = limit
	}
	order := usageOrder(by)
	first := &entryHeap{order: order, items: make([]usageEntry, 0, keep)}
	add := func(e usageEntry) {
		switch {
		case keep == total: // every entry is returned, so no heap is needed
			first.items = append(first.items, e)
		case len(first.items) < keep:
			heap.Push(first, e)
		case order(e, first.items[0]) < 0:
			first.items[0] = e
			heap.Fix(first, 0)
		}
	}
	for _, c := range n.dirs {
		add(usageEntry{name: c.name, bytes: c.total.bytes, files: c.total.files, dir: c})
	}
	for _, f := range n.files {
		add(usageEntry{name: f.name, bytes: max(f.size, 0), files: 1, size: f.size})
	}
	entries := first.items
	slices.SortFunc(entries, order)

	prefix := ""
	if rel != "" {
		prefix = rel + "/"
	}
	rows := make([]UsageRow, len(entries))
	for i, e := range entries {
		if e.dir != nil {
			rows[i] = dirRow(root, e.dir)
			continue
		}
		rows[i] = UsageRow{Name: e.name, Rel: prefix + e.name, Bytes: e.bytes, Files: 1}
		if e.size < 0 {
			rows[i].Unknown = 1
		}
		rows[i].Path = root.Entry(rows[i].Rel)
	}
	return UsageLevel{
		Rel: rel, Total: dirRow(root, n), Rows: rows, More: total - len(rows),
		Rest: UsageRest{Files: n.rest.files, Bytes: n.rest.bytes, Unknown: n.rest.unknown},
	}, true
}

// usageEntry is an entry of a folder as Level orders it, before its row is built. dir is nil for a
// file, whose size is -1 when the backend doesn't know it.
type usageEntry struct {
	name         string
	bytes, files int64
	dir          *usageNode
	size         int64
}

// entryHeap holds the first entries in an order, with the last of them on top, so that an entry
// that comes before it takes its place.
type entryHeap struct {
	order func(a, b usageEntry) int
	items []usageEntry
}

func (h *entryHeap) Len() int           { return len(h.items) }
func (h *entryHeap) Less(i, j int) bool { return h.order(h.items[j], h.items[i]) < 0 }
func (h *entryHeap) Swap(i, j int)      { h.items[i], h.items[j] = h.items[j], h.items[i] }
func (h *entryHeap) Push(x any)         { h.items = append(h.items, x.(usageEntry)) }
func (h *entryHeap) Pop() any {
	e := h.items[len(h.items)-1]
	h.items = h.items[:len(h.items)-1]
	return e
}

func dirRow(root location.Fs, n *usageNode) UsageRow {
	rel := n.rel()
	return UsageRow{
		Name: n.name, Rel: rel, Path: root.Entry(rel), IsDir: true,
		Bytes: n.total.bytes, Files: n.total.files, Folders: n.folders, Unknown: n.total.unknown,
		Unread: n.unread, UnreadBelow: n.unreadBelow,
	}
}

// usageOrder compares two entries in the order by. Ties go by name, so the order never flickers
// between two reads.
func usageOrder(by UsageSort) func(a, b usageEntry) int {
	name := func(a, b usageEntry) int { return CompareNames(a.name, b.name) }
	switch by {
	case ByName:
		return name
	case ByFiles:
		return func(a, b usageEntry) int {
			return cmp.Or(cmp.Compare(b.files, a.files), cmp.Compare(b.bytes, a.bytes), name(a, b))
		}
	default:
		return func(a, b usageEntry) int {
			return cmp.Or(cmp.Compare(b.bytes, a.bytes), cmp.Compare(b.files, a.files), name(a, b))
		}
	}
}

// find returns the folder at rel, or nil when the tree has none.
func (t *UsageTree) find(rel string) *usageNode {
	n := t.root
	if rel == "" {
		return n
	}
	for name := range strings.SplitSeq(rel, "/") {
		if n = n.dirs[name]; n == nil {
			return nil
		}
	}
	return n
}

// Forget takes the entry at rel out of the tree and out of every total above it, after it was
// deleted. isDir says whether it is a folder, because a bucket can hold a file and a folder of
// the same name. It returns false when the tree doesn't hold the entry by name.
func (t *UsageTree) Forget(rel string, isDir bool) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	dir, name := path.Split(rel)
	parent := t.find(strings.TrimSuffix(dir, "/"))
	if parent == nil || name == "" {
		return false
	}
	t.lastDir, t.lastNode = "", t.root // the folder remembered may be the one going away
	if isDir {
		c := parent.dirs[name]
		if c == nil {
			return false
		}
		delete(parent.dirs, name)
		unread := c.unreadBelow
		if c.unread {
			unread++
		}
		for p := parent; p != nil; p = p.parent {
			p.total.sub(c.total)
			p.folders -= c.folders + 1
			p.unreadBelow -= unread
		}
		stack := []*usageNode{c}
		for len(stack) > 0 {
			n := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			t.kept -= len(n.files)
			for _, d := range n.dirs {
				stack = append(stack, d)
			}
		}
		return true
	}
	i := slices.IndexFunc(parent.files, func(f usageFile) bool { return f.name == name })
	if i < 0 {
		return false
	}
	f := heap.Remove(&parent.files, i).(usageFile)
	t.kept--
	for p := parent; p != nil; p = p.parent {
		p.total.sub(fileTotals(f.size))
	}
	return true
}

// scanUsage reads everything below f's root into t. skip names folders below the root that the
// scan leaves out (the mount points of other disks), with / between names.
//
// A backend that lists a whole tree at once (ListR, which buckets have) is read that way, as one
// stream. Any other is walked folder by folder, as many at a time as rclone's --checkers, from
// the top down and taking turns between the folders at the top (walkQueue), so they all grow at
// the same time. A folder that can't be listed is marked and the walk goes on. When the root
// itself can't be listed, scanUsage returns its error.
//
// The stream stops at the first folder it can't list, such as a bucket that refuses its listing.
// The scan then starts again as a walk, which marks that folder and reads the rest.
//
// When ctx ends, the walk stops and the tree keeps what it found.
func scanUsage(ctx context.Context, f fs.Fs, skip map[string]bool, t *UsageTree) error {
	if f.Features().ListR != nil && len(skip) == 0 {
		err := listRUsage(ctx, f, t)
		if err == nil || ctx.Err() != nil {
			return err
		}
		fs.Debugf(f, "Disk Usage: listing the whole tree failed, walking it folder by folder: %v", err)
		t.reset()
	}
	return walkUsage(ctx, f, skip, t)
}

func listRUsage(ctx context.Context, f fs.Fs, t *UsageTree) error {
	err := walk.ListR(ctx, f, "", true, -1, walk.ListAll, func(entries fs.DirEntries) error {
		if len(entries) > 0 {
			dir, _ := path.Split(entries[len(entries)-1].Remote())
			t.reading(strings.TrimSuffix(dir, "/"))
		}
		t.add(entries)
		if t.full() {
			return errStop
		}
		return ctx.Err()
	})
	if errors.Is(err, errStop) {
		return nil
	}
	return err
}

func walkUsage(ctx context.Context, f fs.Fs, skip map[string]bool, t *UsageTree) error {
	var (
		mu      sync.Mutex
		wake    = sync.NewCond(&mu)
		queue   = newWalkQueue()
		busy    int
		rootErr error
		wg      sync.WaitGroup
	)
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		wake.Broadcast()
		mu.Unlock()
	})
	defer stop()

	// next waits for a folder to read. It returns false when there is none left, or the scan
	// stopped.
	next := func() (string, bool) {
		mu.Lock()
		defer mu.Unlock()
		for queue.len() == 0 && busy > 0 && ctx.Err() == nil {
			wake.Wait()
		}
		if queue.len() == 0 || ctx.Err() != nil || t.full() {
			wake.Broadcast()
			return "", false
		}
		busy++
		return queue.pop(), true
	}
	done := func(found []string) {
		mu.Lock()
		defer mu.Unlock()
		busy--
		for _, dir := range found {
			queue.push(dir)
		}
		wake.Broadcast()
	}

	// read lists one folder. A panic while it lists (a fatal rclone error) still ends the folder,
	// marked as unread, so that the other workers don't wait for it. The job runner then
	// recovers the panic, and that worker stops.
	rootDied := false
	read := func(ctx context.Context, dir string) {
		var found []string
		listed := false
		defer func() {
			if !listed {
				t.unread(dir)
				if dir == "" {
					mu.Lock()
					rootDied = true
					mu.Unlock()
				}
			}
			done(found)
		}()
		t.reading(dir)
		found, err := listUsage(ctx, f, dir, skip, t)
		if err != nil && ctx.Err() == nil {
			if dir == "" {
				mu.Lock()
				rootErr = err
				mu.Unlock()
			}
			t.unread(dir)
		}
		listed = true
	}

	// Each worker runs as its own job in the scan's stats group, because rclone can only recover
	// from a fatal error on a goroutine that its job runner started.
	var died error // the last worker's panic
	group, _ := accounting.StatsGroupFromContext(ctx)
	for range max(1, fs.GetConfig(ctx).Checkers) {
		wg.Go(func() {
			_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
				for {
					dir, ok := next()
					if !ok {
						return nil
					}
					read(ctx, dir)
				}
			})
			if err != nil {
				mu.Lock()
				died = err
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	// The scan didn't finish when the root's listing died, or when folders still wait, which
	// happens only when every worker died.
	if rootErr == nil && died != nil && (rootDied || queue.len() > 0 && ctx.Err() == nil && !t.full()) {
		return died
	}
	return rootErr
}

// walkQueue holds the folders that a walk reads next. Each folder at the top of the tree has a
// queue of the folders below it, read in the order they were found, and the walk takes one from
// each in turn. So a scan finds the first files of every top folder early, and their sizes grow
// side by side, instead of one top folder being read to the end before the next.
type walkQueue struct {
	byTop map[string][]string
	tops  []string // the top folders that have folders waiting, in the order they came
	turn  int      // the next top folder to take from
	n     int
}

func newWalkQueue() *walkQueue {
	q := &walkQueue{byTop: map[string][]string{}}
	q.push("")
	return q
}

func (q *walkQueue) len() int { return q.n }

func (q *walkQueue) push(dir string) {
	top, _, _ := strings.Cut(dir, "/")
	if len(q.byTop[top]) == 0 {
		q.tops = append(q.tops, top)
	}
	q.byTop[top] = append(q.byTop[top], dir)
	q.n++
}

// pop returns the next folder. The queue must not be empty.
func (q *walkQueue) pop() string {
	q.turn %= len(q.tops)
	top := q.tops[q.turn]
	waiting := q.byTop[top]
	dir := waiting[0]
	if len(waiting) == 1 {
		delete(q.byTop, top)
		q.tops = slices.Delete(q.tops, q.turn, q.turn+1)
	} else {
		q.byTop[top] = waiting[1:]
		q.turn++
	}
	q.n--
	return dir
}

// listUsage lists one folder into t and returns the folders inside it that the walk reads next.
func listUsage(ctx context.Context, f fs.Fs, dir string, skip map[string]bool, t *UsageTree) ([]string, error) {
	var found []string
	seen := map[string]struct{}{} // a few backends report the same entry twice
	err := listDir(ctx, f, dir, func(entries fs.DirEntries) error {
		batch := entries[:0:0]
		for _, e := range entries {
			rel := e.Remote()
			if _, dup := seen[rel]; dup || rel == "" || skip[rel] {
				continue
			}
			seen[rel] = struct{}{}
			if _, ok := e.(fs.Directory); ok {
				found = append(found, rel)
			}
			batch = append(batch, e)
		}
		t.add(batch)
		return ctx.Err()
	})
	return found, err
}

// UsageRoot is what a scan reads: the root of a remote, or a whole local disk.
type UsageRoot struct {
	location.Fs
	// Skip names the folders below the root that the scan leaves out, with / between names.
	Skip map[string]bool
}

// usageRootOf returns the root of the remote or local disk that the folder at p is on. On a
// remote, that is the remote's root as p writes it, with its parameters and its leading slash
// (`sftp:/` is the machine's root, `sftp:` the login folder). On this machine, it is the disk
// that p is on, and the scan leaves out the mount points below it: other disks, network shares
// and mounted remotes. mounts lists the mount points.
func usageRootOf(p string, mounts func() ([]string, error)) (UsageRoot, error) {
	at, err := folderOf(p, "path", i18n.M("Select a folder on the remote or disk to scan."))
	if err != nil {
		return UsageRoot{}, err
	}
	if !at.Local {
		at.Rel, at.Folder = "", true
		return UsageRoot{Fs: at}, nil
	}
	full := at.Entry(at.Rel)
	var points []string
	if mounts != nil {
		points, _ = mounts() // without the table, the scan can still read the disk
	}
	root, skip := diskRoot(runtime.GOOS, full, points)
	// The disk's root is the anchor, so that rclone opens it and the rows' paths start with it.
	anchor := filepath.ToSlash(root)
	if !strings.HasSuffix(anchor, "/") {
		anchor += "/"
	}
	rootAt := location.Fs{Name: ":local", Config: ":local", Anchor: anchor, Folder: true, Local: true}
	return UsageRoot{Fs: rootAt, Skip: skip}, nil
}

// darwinData is where macOS mounts the volume that holds the user's data. Its folders also
// appear at the top of / through firmlinks, so a scan of / leaves it out and still counts them.
const darwinData = "/System/Volumes/Data"

// diskRoot returns the root of the disk that the local folder full is on, and the mount points
// below that root, as paths below it. points are the mount table's entries.
//
// On Windows, the disk is the path's drive or share. Elsewhere, it is the deepest mount point
// that holds the folder. On macOS, the data volume counts as part of /.
func diskRoot(goos, full string, points []string) (string, map[string]bool) {
	if goos == "windows" {
		return filepath.VolumeName(full) + `\`, nil
	}
	real := full
	if r, err := filepath.EvalSymlinks(full); err == nil {
		real = r
	}
	root := "/"
	for _, p := range points {
		if within(real, p) && len(p) > len(root) {
			root = p
		}
	}
	if goos == "darwin" && root == darwinData {
		root = "/"
	}
	skip := map[string]bool{}
	for _, p := range points {
		if p != root && within(p, root) {
			skip[strings.TrimPrefix(strings.TrimPrefix(p, root), "/")] = true
		}
	}
	return root, skip
}

// within reports whether the slash-separated path p is dir or below it.
func within(p, dir string) bool {
	return dir == "/" || p == dir || strings.HasPrefix(p, dir+"/")
}
