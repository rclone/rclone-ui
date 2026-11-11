package browse

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/fspath"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

// The events that a listing, a search, a folder count and a Disk Usage scan send to the window
// that asked for them.
const (
	EventRows  = "browse:rows"
	EventSize  = "browse:size"
	EventUsage = "browse:usage"
)

// perFrame is the most rows that one event carries. A cached listing of 50 000 rows is sent in
// pieces, and the page shows each piece as it arrives.
const perFrame = 2000

// Row is one entry of a listing or a search.
type Row struct {
	// Path is the entry's full path, with the root written the same way as in the requested folder.
	Path     string `json:"path"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	ModTime  string `json:"modTime"`
	IsDir    bool   `json:"isDir"`
	ID       string `json:"id"`
	Tier     string `json:"tier"`
	IsBucket bool   `json:"isBucket"`
	// Below is the path of a search match, relative to the folder that was searched.
	Below string `json:"below,omitempty"`
}

// Rows is one piece of the rows of a listing or a search, tagged with its request. The last
// piece has Done set and no rows.
type Rows struct {
	Request string `json:"request"`
	Entries []Row  `json:"entries"`
	Done    bool   `json:"done,omitempty"`
	// FetchedAt is when rclone listed the folder, in ms since the epoch. Only the last piece of a
	// listing sets it.
	FetchedAt int64 `json:"fetchedAt,omitempty"`
	// Capped reports that the rows stopped at ListMax or SearchMax.
	Capped bool `json:"capped,omitempty"`
}

// FolderSize is the count for one folder, tagged with its request. The last one has Done set
// and no path.
type FolderSize struct {
	Request string `json:"request"`
	Path    string `json:"path,omitempty"`
	Files   int64  `json:"files"`
	Bytes   int64  `json:"bytes"`
	// Partial marks counts that are incomplete because the work stopped partway through the folder.
	Partial bool `json:"partial,omitempty"`
	Done    bool `json:"done,omitempty"`
}

// CompareResult is the comparison of two folders side by side.
type CompareResult struct {
	Pairs  []Pair `json:"pairs"`
	Capped bool   `json:"capped"`
}

// API lists, searches and counts folders for the pages, and answers their other questions about
// entries.
type API struct {
	l      *late.Value[*Lister]
	emit   func(ctx context.Context, name string, data any)
	mounts func() ([]string, error)
	usage  usageScans
}

// NewAPI returns the API over the listings cache, which l provides once the core has started.
// emit sends an event to the window that made the call in ctx.
func NewAPI(l *late.Value[*Lister], emit func(ctx context.Context, name string, data any)) *API {
	return &API{l: l, emit: emit, mounts: children.MountPoints}
}

// inJob runs one read as an rclone job in its own stats group (ui/<kind>/<id>), and deletes the
// group afterwards. Running it as a job has three effects. A fatal rclone error while opening a
// remote (such as a bad override) becomes the read's error instead of ending the core. The
// global.* keys of a connection string apply only to that remote. And the Fs stays in rclone's
// cache while the read uses it.
func inJob(ctx context.Context, kind string, fn func(ctx context.Context) error) error {
	group := rclone.UIGroup(kind, ids.New())
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, fn)
	return err
}

// folderOf splits a requested folder into the root that rclone opens and the folder below it,
// using location.Split. It refuses an empty path with the message missing, and paths that rclone
// would refuse or misread with the message from location.Problem. Both the listing's cache entry
// and the paths of its rows come from this split.
func folderOf(p, field string, missing i18n.Text) (location.Fs, error) {
	if p == "" {
		return location.Fs{}, errs.Invalid(missing, errs.Violation(field, "missing"))
	}
	if err := location.FieldRefusal(field, p); err != nil {
		// The page receives it as Invalid, with the field and the same sentence as its message.
		return location.Fs{}, err
	}
	// FieldRefusal has already refused every path that Split can't read.
	at, _ := location.Split(p)
	return at, nil
}

// rowOf turns an entry below at's root into the Row a page reads. The row carries the full path,
// with the root written as in the requested folder, so that pages never build paths themselves.
func rowOf(at location.Fs, e Entry) Row {
	return Row{
		Path: at.Entry(e.Path), Name: e.Name, Size: e.Size, ModTime: e.ModTime,
		IsDir: e.IsDir, ID: e.ID, Tier: e.Tier, IsBucket: e.IsBucket,
	}
}

// pieces converts rows with row and passes them to send in pieces of at most perFrame.
func pieces(rows []Entry, row func(Entry) Row, send func([]Row)) {
	for len(rows) > 0 {
		n := min(len(rows), perFrame)
		out := make([]Row, n)
		for i, e := range rows[:n] {
			out[i] = row(e)
		}
		send(out)
		rows = rows[n:]
	}
}

// ListFolder lists a folder from the cache while the cached copy is fresh, and from rclone
// otherwise. It calls page with the rows as each batch arrives. It returns when rclone listed
// the folder (in ms since the epoch) and whether the rows stopped at ListMax.
func ListFolder(ctx context.Context, l *Lister, path string, fresh, fileDates bool, page func([]Row)) (fetchedAt int64, capped bool, err error) {
	at, err := folderOf(path, "path", i18n.M("Specify the folder to list."))
	if err != nil {
		return 0, false, err
	}
	row := func(e Entry) Row { return rowOf(at, e) }
	n := 0
	err = inJob(ctx, "list", func(ctx context.Context) (err error) {
		fetchedAt, err = l.List(ctx, at.Root(), at.Rel, fresh, fileDates, ListMax, func(rows []Entry) {
			n += len(rows)
			pieces(rows, row, page)
		})
		return err
	})
	if err != nil {
		return 0, false, err
	}
	return fetchedAt, n >= ListMax, nil
}

// List lists a folder, sending its rows as EventRows for request. fileDates reads the files' dates
// on S3, Swift and the other backends where each costs a request (Commander's File dates).
func (a *API) List(ctx context.Context, request, path string, fresh, fileDates bool) error {
	return a.l.Do(ctx, func(l *Lister) error {
		fetchedAt, capped, err := ListFolder(ctx, l, path, fresh, fileDates, func(rows []Row) {
			a.emit(ctx, EventRows, Rows{Request: request, Entries: rows})
		})
		if err != nil {
			return err
		}
		a.emit(ctx, EventRows, Rows{Request: request, Entries: []Row{}, Done: true, FetchedAt: fetchedAt, Capped: capped})
		return nil
	})
}

// errCapped stops a search at its most matches.
var errCapped = errors.New("enough results")

// SearchFolder finds the entries under the folder at path whose names contain q (Search, which
// reads at most SearchWalkMax entries), and calls page with their rows as they are found. It
// stops after max matches, and reports whether it did. When the walk ended at SearchWalkMax, it
// returns ErrWalkMax, after the rows it found. fileDates is as for List.
func SearchFolder(ctx context.Context, path, q string, max int, fileDates bool, page func([]Row)) (capped bool, err error) {
	if q == "" {
		return false, errs.Invalid(i18n.M("Nothing to search for."), errs.Violation("q", "missing"))
	}
	at, err := folderOf(path, "path", i18n.M("Specify the folder to search."))
	if err != nil {
		return false, err
	}
	// A match is shown by its path below the folder searched.
	row := func(e Entry) Row {
		r := rowOf(at, e)
		r.Below = strings.TrimPrefix(e.Path, at.Dir())
		return r
	}
	ctx, stop := context.WithCancelCause(ctx)
	defer stop(nil)
	n := 0
	err = inJob(ctx, "search", func(ctx context.Context) error {
		return Search(ctx, at.Root(), at.Rel, q, SearchWalkMax, fileDates, func(found []Entry) {
			if n >= max {
				return
			}
			found = found[:min(len(found), max-n)]
			n += len(found)
			pieces(found, row, page)
			if n >= max {
				stop(errCapped)
			}
		})
	})
	if errors.Is(context.Cause(ctx), errCapped) {
		return true, nil
	}
	return false, err
}

// Search finds the entries under a folder whose names contain q, sending them as EventRows
// for request. It stops at SearchMax matches. fileDates is as for List.
func (a *API) Search(ctx context.Context, request, path, q string, fileDates bool) error {
	capped, err := SearchFolder(ctx, path, q, SearchMax, fileDates, func(rows []Row) {
		a.emit(ctx, EventRows, Rows{Request: request, Entries: rows})
	})
	// The page isn't told that a walk ended at SearchWalkMax.
	if err != nil && !errors.Is(err, ErrWalkMax) {
		return err
	}
	a.emit(ctx, EventRows, Rows{Request: request, Entries: []Row{}, Done: true, Capped: capped})
	return nil
}

// CountFolder counts the files and their bytes below the folder at path, as Sizes counts each of
// its folders, but it returns the reason when the folder can't be counted. When ctx ends partway,
// it returns the counts so far, marked Partial, with ctx's error.
func CountFolder(ctx context.Context, path string) (Size, error) {
	if _, err := folderOf(path, "path", i18n.M("Specify the folder to count.")); err != nil {
		return Size{}, err
	}
	s := Size{Path: path}
	err := inJob(ctx, "sizes", func(ctx context.Context) (err error) {
		s, err = count(ctx, path)
		return err
	})
	if err != nil && ctx.Err() != nil {
		s.Partial = true
	}
	return s, err
}

// Sizes counts each folder's size and files, sending each as EventSize for request as it is
// counted.
func (a *API) Sizes(ctx context.Context, request string, paths []string) error {
	err := inJob(ctx, "sizes", func(ctx context.Context) error {
		return Sizes(ctx, paths, func(s Size) {
			a.emit(ctx, EventSize, FolderSize{Request: request, Path: s.Path, Files: s.Files, Bytes: s.Bytes, Partial: s.Partial})
		})
	})
	if err != nil {
		return err
	}
	a.emit(ctx, EventSize, FolderSize{Request: request, Done: true})
	return nil
}

// Compare puts two folders side by side, one level down. fileDates is as for List.
func (a *API) Compare(ctx context.Context, left, right string, fileDates bool) (CompareResult, error) {
	if left == "" || right == "" {
		return CompareResult{}, errs.Invalid(i18n.M("Two folders are needed."), errs.Violation("right", "missing"))
	}
	// Check both paths the same way a listing does, since rclone would refuse or misread them.
	for _, side := range [][2]string{{"left", left}, {"right", right}} {
		if _, err := folderOf(side[1], side[0], i18n.M("Two folders are needed.")); err != nil {
			return CompareResult{}, err
		}
	}
	var c Comparison
	err := inJob(ctx, "compare", func(ctx context.Context) (err error) {
		c, err = Compare(ctx, left, right, fileDates)
		return err
	})
	if err != nil {
		return CompareResult{}, err
	}
	return CompareResult{Pairs: c.Pairs[:min(len(c.Pairs), CompareMax)], Capped: c.Capped || len(c.Pairs) > CompareMax}, nil
}

// Disks returns the disks and folders on this machine that the pickers offer, using rclone's
// core/disks.
func (a *API) Disks(ctx context.Context) ([]string, error) { return rclone.Disks(ctx) }

// PublicLink creates a public link to an entry, on backends that support them.
func (a *API) PublicLink(ctx context.Context, path string) (string, error) {
	parent, leaf, err := fspath.Split(path)
	if err != nil || leaf == "" {
		return "", errs.Invalid(i18n.M("Pick an entry inside the folder."), errs.Violation("path", "a root"))
	}
	var link string
	err = inJob(ctx, "link", func(ctx context.Context) error {
		f, err := cache.Get(ctx, parent)
		if err != nil {
			return err
		}
		link, err = operations.PublicLink(ctx, f, leaf, fs.DurationOff, false)
		return err
	})
	if err != nil {
		return "", err
	}
	return link, nil
}

// UsageState is where a Disk Usage scan is.
type UsageState string

// The states of a scan.
const (
	UsageScanning UsageState = "scanning"
	UsageDone     UsageState = "done"
	// UsageStopped is a scan that the user stopped. Its tree holds what it found until then.
	UsageStopped UsageState = "stopped"
	// UsageCapped is a scan that reached UsageFolderMax folders and stopped there.
	UsageCapped UsageState = "capped"
	// UsageFailed is a scan that stopped on an error after it found something.
	UsageFailed UsageState = "failed"
)

// UsageProgress is where a scan is, tagged with its request. A scan sends it a few times a
// second while it runs, and once when it ends.
type UsageProgress struct {
	Request string `json:"request"`
	// Root is the scanned root, written as a listing's rows write paths (`gdrive:`, `/`, `C:\`).
	Root string `json:"root"`
	// Local is true for a disk on this machine.
	Local bool       `json:"local"`
	Count UsageCount `json:"count"`
	State UsageState `json:"state"`
	// Error is why a failed scan stopped.
	Error string `json:"error,omitempty"`
	// EndedAt is when the scan ended, in ms since the epoch.
	EndedAt int64 `json:"endedAt,omitempty"`
}

const (
	// usageBeat is how often a running scan sends its progress.
	usageBeat = 250 * time.Millisecond
	// usageIdle is how long an ended scan is kept while no page reads it.
	usageIdle = 30 * time.Minute
	// usageScansMax is the most scans kept at once. A page that reloads can't end the scan it
	// started, so the oldest one is let go when another starts.
	usageScansMax = 2
	// usageRowsMax is the most rows that one read of a folder returns.
	usageRowsMax = 5000
)

// errUsageStopped is the cause of a scan that the user stopped.
var errUsageStopped = errors.New("the scan was stopped")

// usageScan is a scan that a page holds.
type usageScan struct {
	root UsageRoot
	tree *UsageTree
	stop context.CancelCauseFunc // ends the walk and keeps the tree
	end  context.CancelFunc      // lets go of the scan
	read chan struct{}           // a page read the scan

	mu sync.Mutex
	// resend sends the scan's progress again, with its totals as they are now. It is set once
	// the scan has ended. Until then, the scan sends its progress on its own beat.
	resend func()
}

// usageScans are the scans that pages hold, by request.
type usageScans struct {
	mu    sync.Mutex
	m     map[string]*usageScan
	order []string // oldest first
}

func (u *usageScans) add(request string, s *usageScan) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.m == nil {
		u.m = map[string]*usageScan{}
	}
	u.m[request] = s
	u.order = append(u.order, request)
	for len(u.order) > usageScansMax {
		if old := u.m[u.order[0]]; old != nil {
			old.end()
		}
		u.order = u.order[1:]
	}
}

func (u *usageScans) remove(request string, s *usageScan) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.m[request] == s {
		delete(u.m, request)
		u.order = slices.DeleteFunc(u.order, func(r string) bool { return r == request })
	}
}

// get returns the scan of request, and counts the call as a read.
func (u *usageScans) get(request string) (*usageScan, error) {
	u.mu.Lock()
	s := u.m[request]
	u.mu.Unlock()
	if s == nil {
		return nil, errs.NotFound("scan", "This scan is no longer available. Scan again to see the disk usage.")
	}
	select {
	case s.read <- struct{}{}:
	default:
	}
	return s, nil
}

// Usage scans the whole remote, or the whole local disk, that the folder at path is on, for
// Disk Usage. While it scans, it sends EventUsage for request a few times a second, and once more
// when it ends. Then it keeps the result for the page and returns when the page cancels the
// call, when another scan replaces it, or when no page read it for usageIdle. UsageLevel reads
// the result one folder at a time, during the scan and after it.
//
// When nothing could be read at all, the call returns the error instead (a remote that doesn't
// open, or whose root can't be listed).
func (a *API) Usage(ctx context.Context, request, path string) error {
	root, err := usageRootOf(path, a.mounts)
	if err != nil {
		return err
	}
	ctx, end := context.WithCancel(ctx)
	defer end()
	walkCtx, stop := context.WithCancelCause(ctx)
	defer stop(nil)
	s := &usageScan{root: root, tree: NewUsageTree(), stop: stop, end: end, read: make(chan struct{}, 1)}
	a.usage.add(request, s)
	defer a.usage.remove(request, s)

	send := func(state UsageState, err error, endedAt int64) {
		a.emit(ctx, EventUsage, UsageProgress{
			Request: request, Root: root.Entry(""), Local: root.Local, Count: s.tree.Count(),
			State: state, Error: i18n.Localize(err), EndedAt: endedAt,
		})
	}
	send(UsageScanning, nil, 0)
	scanned := make(chan error, 1)
	go func() {
		scanned <- inJob(walkCtx, "usage", func(ctx context.Context) error {
			f, err := getFs(ctx, root.Root())
			if err != nil {
				return err
			}
			return scanUsage(ctx, f, root.Skip, s.tree)
		})
	}()
	beat := time.NewTicker(usageBeat)
	var scanErr error
running:
	for {
		select {
		case scanErr = <-scanned:
			break running
		case <-beat.C:
			send(UsageScanning, nil, 0)
		}
	}
	beat.Stop()
	if ctx.Err() != nil {
		return nil // the page let go of the scan, or another one replaced it
	}
	count := s.tree.Count()
	state := UsageDone
	switch {
	case errors.Is(context.Cause(walkCtx), errUsageStopped):
		state, scanErr = UsageStopped, nil
	case scanErr != nil && count.Files == 0 && count.Folders == 0:
		return scanErr
	case scanErr != nil:
		state = UsageFailed
	case count.Capped:
		state = UsageCapped
	}
	endedAt := time.Now().UnixMilli()
	send(state, scanErr, endedAt)
	s.mu.Lock()
	s.resend = func() { send(state, scanErr, endedAt) }
	s.mu.Unlock()

	idle := time.NewTimer(usageIdle)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.read:
			idle.Reset(usageIdle)
		case <-idle.C:
			return nil
		}
	}
}

// UsageRoot returns the root that a scan of the folder at path reads (`gdrive:`, `/`, `C:\`),
// as UsageProgress writes it. A page compares it with the root of the scan it holds, to show that
// scan again rather than start one.
func (a *API) UsageRoot(ctx context.Context, path string) (string, error) {
	root, err := usageRootOf(path, a.mounts)
	if err != nil {
		return "", err
	}
	return root.Entry(""), nil
}

// UsageLevel returns one folder of a scan, during the scan or after it: the folder's totals and
// its first limit rows in the order by. rel is the folder below the scan's root, "" for the root.
func (a *API) UsageLevel(ctx context.Context, request, rel string, by UsageSort, limit int) (UsageLevel, error) {
	s, err := a.usage.get(request)
	if err != nil {
		return UsageLevel{}, err
	}
	if limit <= 0 || limit > usageRowsMax {
		limit = usageRowsMax
	}
	level, ok := s.tree.Level(s.root.Fs, rel, by, limit)
	if !ok {
		return UsageLevel{}, errs.NotFound("folder", "The scan has no folder %s.", rel)
	}
	return level, nil
}

// UsageStop stops a scan's walk. The scan keeps what it found, and ends as stopped.
func (a *API) UsageStop(ctx context.Context, request string) error {
	s, err := a.usage.get(request)
	if err != nil {
		return err
	}
	s.stop(errUsageStopped)
	return nil
}

// UsageForget takes an entry that was deleted out of a scan and out of every total above it. rel
// is the entry's path below the scan's root, and isDir says whether it is a folder.
func (a *API) UsageForget(ctx context.Context, request, rel string, isDir bool) error {
	s, err := a.usage.get(request)
	if err != nil {
		return err
	}
	if !s.tree.Forget(rel, isDir) {
		return nil
	}
	s.mu.Lock()
	resend := s.resend
	s.mu.Unlock()
	if resend != nil {
		resend() // the totals at the top changed
	}
	return nil
}
