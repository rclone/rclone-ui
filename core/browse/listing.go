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
	ListingFresh = 5 * time.Minute
	ListingKeep  = 30 * time.Minute

	sweepEvery = time.Minute
)

const (
	ListMax       = 50000
	SearchMax     = 5000
	SearchWalkMax = 1000000
	CompareMax    = 20000
)

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

type Lister struct {
	now         func() time.Time
	fresh, keep time.Duration

	mu     sync.Mutex
	states map[listingKey]*state
	gen    uint64
	sweep  *time.Timer
}

type listingKey struct{ fs, dir string }

type state struct {
	at    place
	atOK  bool
	gen   uint64
	asked time.Time
	last  *listing
}

type listing struct {
	rows      []Entry
	fileDates bool
	fetchedAt time.Time
	gen       uint64
	capped    bool
}

func NewLister() *Lister {
	return &Lister{now: time.Now, fresh: ListingFresh, keep: ListingKeep, states: map[listingKey]*state{}}
}

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
	if st := l.states[k]; st != nil && st.gen == gen {
		st.last = &listing{rows: rows, fileDates: fileDates, fetchedAt: asked, gen: gen, capped: capped}
	}
	return asked.UnixMilli(), nil
}

func (l *Lister) InvalidateRemotes(names []string) {
	l.invalidate(func(p place) bool { return slices.Contains(names, p.remote) })
}

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

var errStop = errors.New("browse: cap reached")

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

func getFs(ctx context.Context, fsName string) (fs.Fs, error) {
	f, err := cache.Get(ctx, fsName)
	if errors.Is(err, fs.ErrorIsFile) {
		return nil, errs.Errorf("%s is a file, not a folder", fsName)
	}
	return f, err
}

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

func slowModTime(ctx context.Context, f fs.Fs) bool {
	return f.Features().SlowModTime && !fs.GetConfig(ctx).UseServerModTime
}

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
		it.IsDir, it.IsBucket = true, m.isBucket && !strings.Contains(e.Remote(), "/")
	case fs.Object:
		if do, ok := x.(fs.GetTierer); ok && m.tier {
			it.Tier = do.GetTier()
		}
	}
	return it
}

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
