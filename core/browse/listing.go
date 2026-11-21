// Package browse reads folders through rclone for the pages. It provides listings behind an
// in-memory cache, recursive search, folder sizes, and the comparison of two folders. Each of
// these works on the context it is given. The API runs each call as an rclone job (rclone.Run,
// like everything else that opens a remote) in its own ui/<kind>/<id> stats group. rclone's
// errors are returned with their original text, so any advice in them to reconnect reaches the
// page.
package browse

import (
	"context"
	"errors"
	"path"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/list"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
)

const (
	// ListingFresh is how long a cached listing is served without asking rclone again.
	ListingFresh = 5 * time.Minute
	// ListingKeep is how long a listing stays in memory after it was last requested.
	ListingKeep = 30 * time.Minute

	// sweepEvery is how often listings older than ListingKeep are dropped, while any are held.
	sweepEvery = time.Minute
)

// The limits for the pages. Past them the work stops early, and the page tells the user.
const (
	ListMax   = 50000
	SearchMax = 5000
	// SearchWalkMax is the most entries a search reads, whether they match or not. On a bucket,
	// rclone keeps every folder that its walk passed through until the walk ends. The page is
	// not told.
	SearchWalkMax = 1000000
	CompareMax    = 20000
)

// Entry is one row of a listing or a search. Path is relative to the listed root, like rclone's
// remote paths, and includes the folder. The cache holds one listing for every way of writing
// the folder, and the API writes each row's full path the way its request did (location.Fs.Entry).
// There is no MimeType, because on some backends it costs one request per object. There are no
// Hashes either, because only the comparison needs them.
type Entry struct {
	Path     string
	Name     string
	Size     int64
	ModTime  string
	IsDir    bool
	ID       string
	Tier     string
	IsBucket bool
}

// Lister is the listings cache. It holds one shared listing per (fs, dir). A listing is served
// without asking rclone while it is fresh (ListingFresh), and kept for ListingKeep after it was
// last requested. Listings are never saved to disk, and a failed listing is not kept. Only a
// refresh, an invalidation or age makes the Lister ask rclone again.
type Lister struct {
	now         func() time.Time
	fresh, keep time.Duration

	mu     sync.Mutex
	states map[listingKey]*state
	gen    uint64
	sweep  *time.Timer
}

type listingKey struct{ fs, dir string }

// state is the cache entry for one (fs, dir). It holds the listing and a generation number,
// which changes when the cached listing may no longer be served.
type state struct {
	at    place
	atOK  bool
	gen   uint64
	asked time.Time
	last  *listing
}

type listing struct {
	rows      []Entry // sorted by Path
	fileDates bool    // the files' dates were read on a backend where they are slow (see slowModTime)
	fetchedAt time.Time
	gen       uint64 // the state's generation when rclone was asked
	capped    bool   // the listing stopped at the caller's max
}

func NewLister() *Lister {
	return &Lister{now: time.Now, fresh: ListingFresh, keep: ListingKeep, states: map[listingKey]*state{}}
}

// List emits the rows of dir under fs (in the form Clean returns) and returns when rclone was
// asked for them, in ms. The rows come from the cache while it is fresh, unless fresh is set for
// a refresh. Otherwise they come from rclone, and each batch is emitted as it arrives. Each batch
// has duplicates removed by Path and is sorted within itself, while the cached copy is sorted as
// a whole. List returns at most max rows, and a paged backend's listing stops there. fileDates
// reads the files' dates even where each costs a request (see slowModTime), and a cached listing
// is served only if it was made the same way.
// emit must not modify or keep the slice it is given.
func (l *Lister) List(ctx context.Context, fsName, dir string, fresh, fileDates bool, max int, emit func([]Entry)) (int64, error) {
	fsName, dir = Clean(fsName, dir)
	k := listingKey{fsName, dir}
	l.mu.Lock()
	st := l.stateLocked(k)
	if c := st.last; !fresh && c != nil && c.gen == st.gen && c.fileDates == fileDates && l.freshLocked(c) && (!c.capped || len(c.rows) >= max) {
		l.mu.Unlock()
		rows := c.rows[:min(len(c.rows), max)]
		if len(rows) > 0 {
			emit(rows)
		}
		return c.fetchedAt.UnixMilli(), nil
	}
	gen := st.gen
	l.mu.Unlock()

	asked := l.now()
	rows, capped, err := fetch(ctx, fsName, dir, max, fileDates, emit)
	if err != nil {
		return 0, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// A change made while rclone was listing may be missing from the result. In that case the
	// result isn't kept, so the next request fetches again.
	if st := l.states[k]; st != nil && st.gen == gen {
		st.last = &listing{rows: rows, fileDates: fileDates, fetchedAt: asked, gen: gen, capped: capped}
	}
	return asked.UnixMilli(), nil
}

// InvalidateRemotes forgets every listing on these remotes. It is called after a config change,
// with the changed remotes and the remotes that wrap them, as named by the remotes service.
func (l *Lister) InvalidateRemotes(names []string) {
	l.invalidate(func(p place) bool { return slices.Contains(names, p.remote) })
}

// InvalidatePaths records a change to each path, such as a folder created, or an entry renamed
// or deleted through the file actions. It forgets the listing of the folder that holds the path.
// For a folder it also forgets the folder's own listing and every listing below it. For a file,
// that second part matches nothing.
func (l *Lister) InvalidatePaths(paths ...string) {
	var entries []place
	for _, p := range paths {
		if at, ok := placeOf(p); ok {
			entries = append(entries, at)
		}
	}
	l.invalidate(func(q place) bool {
		for _, p := range entries {
			if q == p.parent() || p.covers(q) {
				return true
			}
		}
		return false
	})
}

// InvalidateFolders forgets the listing of each folder, every listing below it, and every listing
// above it, where a folder created by the change shows up. An example is the destination of a
// copy.
func (l *Lister) InvalidateFolders(paths ...string) {
	var folders []place
	for _, p := range paths {
		if at, ok := placeOf(p); ok {
			folders = append(folders, at)
		}
	}
	l.invalidate(func(q place) bool {
		return slices.ContainsFunc(folders, func(p place) bool { return p.covers(q) || q.covers(p) })
	})
}

// TransferEnded forgets the listings that a transfer changed. Its destination changed, and so
// did every folder above it, where a folder that the transfer created shows up. A download's
// destination is the file it wrote, so the folder that holds the file is covered too. A move, a
// delete and a purge also changed the folders that held the sources. A bisync writes to its
// source as well as its destination.
func (l *Lister) TransferEnded(operation operations.Operation, sources []string, destination string) {
	if destination != "" {
		l.InvalidateFolders(destination)
	}
	switch operation {
	case operations.OperationMove, operations.OperationDelete, operations.OperationPurge:
		l.InvalidatePaths(sources...)
	case operations.OperationBisync:
		l.InvalidateFolders(sources...)
	}
}

func (l *Lister) invalidate(match func(place) bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, st := range l.states {
		if st.atOK && match(st.at) {
			st.gen = l.nextGenLocked()
			st.last = nil
		}
	}
}

// stateLocked returns the state for k, creating it if needed, and marks it as requested now.
func (l *Lister) stateLocked(k listingKey) *state {
	now := l.now()
	l.sweepLocked(now)
	st := l.states[k]
	if st == nil {
		st = &state{gen: l.nextGenLocked()}
		st.at, st.atOK = placeOf(Join(k.fs, k.dir))
		l.states[k] = st
		if l.sweep == nil {
			l.sweep = time.AfterFunc(sweepEvery, l.tick)
		}
	}
	st.asked = now
	return st
}

func (l *Lister) freshLocked(c *listing) bool { return l.now().Sub(c.fetchedAt) < l.fresh }

func (l *Lister) nextGenLocked() uint64 {
	l.gen++
	return l.gen
}

func (l *Lister) sweepLocked(now time.Time) {
	for k, st := range l.states {
		if now.Sub(st.asked) >= l.keep {
			delete(l.states, k)
		}
	}
}

func (l *Lister) tick() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(l.now())
	if len(l.states) > 0 {
		l.sweep.Reset(sweepEvery)
	} else {
		l.sweep = nil
	}
}

// errStop ends a listing when it reaches its cap.
var errStop = errors.New("browse: cap reached")

// fetch asks rclone to list dir under fs, returning at most max rows. fileDates reads the files'
// dates even where each costs a request (see slowModTime).
func fetch(ctx context.Context, fsName, dir string, max int, fileDates bool, emit func([]Entry)) (rows []Entry, capped bool, err error) {
	f, err := getFs(ctx, fsName)
	if err != nil {
		return nil, false, err
	}
	mk := newEntryMaker(ctx, f, dir, fileDates)
	seen := map[string]struct{}{}
	var mu sync.Mutex
	add := func(entries fs.DirEntries) error {
		mu.Lock()
		defer mu.Unlock()
		var batch []Entry
		for _, e := range entries {
			if len(rows)+len(batch) >= max {
				break
			}
			// A few backends report the same object twice.
			if _, dup := seen[e.Remote()]; dup {
				continue
			}
			seen[e.Remote()] = struct{}{}
			batch = append(batch, mk.entry(ctx, e))
		}
		sortByPath(batch)
		rows = append(rows, batch...)
		if len(batch) > 0 {
			emit(batch)
		}
		if len(rows) >= max {
			capped = true
			return errStop
		}
		return nil
	}
	err = listDir(ctx, f, dir, add)
	if err != nil && dir != "" && !errors.Is(err, errStop) && ctx.Err() == nil {
		// Some backends want a folder with a trailing slash, and others refuse it. When the retry
		// fails too, the first error is returned because it explains the real problem. Most
		// backends simply have no folder with a trailing slash.
		first := err
		if err = listDir(ctx, f, dir+"/", add); err != nil && !errors.Is(err, errStop) {
			err = first
		}
	}
	if errors.Is(err, errStop) {
		err = nil
	}
	if err != nil {
		return nil, false, err
	}
	sortByPath(rows)
	return rows, capped, nil
}

// listDir lists dir of f one level down, passing each batch to add until add returns an error.
// It uses the Fs's ListP when there is one, which paged backends have, so a cap stops the listing
// after the page where it is reached. Otherwise it uses List.
func listDir(ctx context.Context, f fs.Fs, dir string, add fs.ListRCallback) error {
	stats := accounting.Stats(ctx)
	cb := func(entries fs.DirEntries) error {
		stats.Listed(int64(len(entries)))
		return add(list.RemoveEscaping(entries))
	}
	if listP := f.Features().ListP; listP != nil {
		return listP(ctx, dir, cb)
	}
	entries, err := f.List(ctx, dir)
	if err != nil {
		return err
	}
	return cb(entries)
}

// getFs returns the Fs of a folder from rclone's fs cache, which a config change clears.
func getFs(ctx context.Context, fsName string) (fs.Fs, error) {
	f, err := cache.Get(ctx, fsName)
	if errors.Is(err, fs.ErrorIsFile) {
		return nil, errs.Errorf("%s is a file, not a folder", fsName)
	}
	return f, err
}

// entryMaker builds Entries the same way as rclone's fs/operations/lsjson.go, with noMimeType set,
// and with noModTime set for the files of a backend whose mod times are slow, unless the user
// asked for them (see slowModTime).
type entryMaker struct {
	format      string
	isBucket    bool
	tier        bool
	slowModTime bool
}

func newEntryMaker(ctx context.Context, f fs.Fs, dir string, fileDates bool) entryMaker {
	ft := f.Features()
	return entryMaker{
		format:      timeFormat(f.Precision()),
		isBucket:    ft.BucketBased && dir == "" && f.Root() == "",
		tier:        ft.GetTier,
		slowModTime: !fileDates && slowModTime(ctx, f),
	}
}

// slowModTime reports whether reading a file's mod time costs a request of its own. s3, swift
// and a few other backends keep it in metadata that a listing doesn't return, so each file would
// need a HEAD request, one after another: minutes for a large folder. Their files are then shown
// without a time, as rclone's --no-modtime does, unless the user turns on File dates in
// Commander. With --use-server-modtime, the time in the listing is used, which costs nothing.
func slowModTime(ctx context.Context, f fs.Fs) bool {
	return f.Features().SlowModTime && !fs.GetConfig(ctx).UseServerModTime
}

// modTimeOf returns e's mod time, or the zero time for a file whose time is slow to read. A
// folder's time comes with the listing.
func modTimeOf(ctx context.Context, e fs.DirEntry, slow bool) time.Time {
	if _, file := e.(fs.Object); file && slow {
		return time.Time{}
	}
	return e.ModTime(ctx)
}

func (m entryMaker) entry(ctx context.Context, e fs.DirEntry) Entry {
	it := Entry{Path: e.Remote(), Name: path.Base(e.Remote()), Size: e.Size()}
	if e.Remote() == "" {
		it.Name = ""
	}
	if t := modTimeOf(ctx, e, m.slowModTime); !t.IsZero() {
		it.ModTime = t.Format(m.format)
	}
	if do, ok := e.(fs.IDer); ok {
		it.ID = do.ID()
	}
	switch x := e.(type) {
	case fs.Directory:
		// Only the top level of a bucket-based remote's root holds buckets.
		it.IsDir, it.IsBucket = true, m.isBucket && !strings.Contains(e.Remote(), "/")
	case fs.Object:
		if do, ok := x.(fs.GetTierer); ok && m.tier {
			it.Tier = do.GetTier()
		}
	}
	return it
}

// timeFormat returns the ModTime format for a backend's precision, as formatForPrecision in
// lsjson.go does.
func timeFormat(precision time.Duration) string {
	switch {
	case precision <= time.Nanosecond:
		return "2006-01-02T15:04:05.000000000Z07:00"
	case precision <= 10*time.Nanosecond:
		return "2006-01-02T15:04:05.00000000Z07:00"
	case precision <= 100*time.Nanosecond:
		return "2006-01-02T15:04:05.0000000Z07:00"
	case precision <= time.Microsecond:
		return "2006-01-02T15:04:05.000000Z07:00"
	case precision <= 10*time.Microsecond:
		return "2006-01-02T15:04:05.00000Z07:00"
	case precision <= 100*time.Microsecond:
		return "2006-01-02T15:04:05.0000Z07:00"
	case precision <= time.Millisecond:
		return "2006-01-02T15:04:05.000Z07:00"
	case precision <= 10*time.Millisecond:
		return "2006-01-02T15:04:05.00Z07:00"
	case precision <= 100*time.Millisecond:
		return "2006-01-02T15:04:05.0Z07:00"
	}
	return time.RFC3339
}

func sortByPath(rows []Entry) {
	slices.SortStableFunc(rows, func(a, b Entry) int { return strings.Compare(a.Path, b.Path) })
}
