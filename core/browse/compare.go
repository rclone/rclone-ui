package browse

import (
	"context"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/rclone"
)

// Class is the group that a name falls into in a comparison. The classes match the groups in
// CompareDrawer.tsx, in the same order.
type Class string

const (
	OnlyLeft  Class = "onlyLeft"
	OnlyRight Class = "onlyRight"
	// SameByName is a name on both sides without a matching common hash, either because no
	// common hash is known or because the digests differ.
	SameByName Class = "sameByName"
	// SameByHash is a name on both sides with equal digests for a common hash type.
	SameByHash Class = "sameByHash"
)

// Side describes a name on one side of a comparison.
type Side struct {
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"` // -1 when the backend does not know
	ModTime string `json:"modTime,omitempty"`
}

// Pair is one name in a comparison. In the only-left and only-right classes, one side is nil.
type Pair struct {
	Class Class  `json:"class"`
	Name  string `json:"name"`
	Left  *Side  `json:"left,omitempty"`
	Right *Side  `json:"right,omitempty"`
}

// Comparison is two folders side by side. Each name appears once. Pairs are grouped by class in
// the order of the Class constants, and within a class, folders come first, then names in order.
type Comparison struct {
	Pairs []Pair
	// Capped reports that a side held more than CompareMax names and its listing stopped there.
	// Some names are then missing, and a name that the other side has may be in the wrong class.
	Capped bool
}

// Compare lists the folders left and right (rclone paths) one level down and sorts their names
// into the four classes, leaving out names that start with a dot. Each side stops at CompareMax
// names, and Comparison.Capped reports when that happened.
func Compare(ctx context.Context, left, right string, fileDates bool) (Comparison, error) {
	var (
		fss   [2]fs.Fs
		sides [2]side
		errs  [2]error
		wg    sync.WaitGroup
	)
	locs := [2]string{left, right}
	// Both remotes are opened on the caller's goroutine, which runs an rclone job, because a fatal
	// rclone error while opening a remote can only be recovered there. They are then listed in
	// parallel.
	for i := range locs {
		f, err := getFs(ctx, locs[i])
		if err != nil {
			return Comparison{}, fmt.Errorf("%s: %w", locs[i], err)
		}
		fss[i] = f
	}
	// Each side is listed as its own job in the comparison's stats group, because rclone can only
	// recover from a fatal error on a goroutine that its job runner started.
	group, _ := accounting.StatsGroupFromContext(ctx)
	for i := range locs {
		wg.Go(func() {
			_, errs[i] = rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) (err error) {
				sides[i], err = listSide(ctx, fss[i], fileDates)
				return err
			})
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			return Comparison{}, fmt.Errorf("%s: %w", locs[i], err)
		}
	}
	l, r := sides[0], sides[1]

	rightByName := make(map[string]*item, len(r.items))
	for i := range r.items {
		rightByName[r.items[i].name] = &r.items[i]
	}
	var byClass [4][]Pair
	for i := range l.items {
		li := &l.items[i]
		ri := rightByName[li.name]
		switch {
		case ri == nil:
			byClass[0] = append(byClass[0], Pair{Class: OnlyLeft, Name: li.name, Left: &li.side})
		case sameByHash(ctx, li.obj, ri.obj):
			byClass[3] = append(byClass[3], Pair{Class: SameByHash, Name: li.name, Left: &li.side, Right: &ri.side})
		default:
			byClass[2] = append(byClass[2], Pair{Class: SameByName, Name: li.name, Left: &li.side, Right: &ri.side})
		}
		if ri != nil {
			ri.paired = true
		}
	}
	for i := range r.items {
		if ri := &r.items[i]; !ri.paired {
			byClass[1] = append(byClass[1], Pair{Class: OnlyRight, Name: ri.name, Right: &ri.side})
		}
	}
	return Comparison{Pairs: slices.Concat(byClass[:]...), Capped: l.capped || r.capped}, nil
}

type side struct {
	items  []item // folders first, then by name
	capped bool   // the listing stopped at CompareMax
}

type item struct {
	name   string
	side   Side
	obj    fs.Object // nil for a folder
	paired bool
}

func listSide(ctx context.Context, f fs.Fs, fileDates bool) (side, error) {
	format := timeFormat(f.Precision())
	slow := !fileDates && slowModTime(ctx, f)
	var s side
	seen := map[string]struct{}{}
	var mu sync.Mutex
	err := listDir(ctx, f, "", func(entries fs.DirEntries) error {
		mu.Lock()
		defer mu.Unlock()
		for _, e := range entries {
			if len(s.items) >= CompareMax {
				s.capped = true
				return errStop
			}
			name := path.Base(e.Remote())
			if e.Remote() == "" || strings.HasPrefix(name, ".") {
				continue
			}
			if _, dup := seen[name]; dup {
				continue
			}
			seen[name] = struct{}{}
			it := item{name: name, side: Side{Size: e.Size()}}
			if t := modTimeOf(ctx, e, slow); !t.IsZero() {
				it.side.ModTime = t.Format(format)
			}
			switch x := e.(type) {
			case fs.Directory:
				it.side.IsDir = true
			case fs.Object:
				it.obj = x
			}
			s.items = append(s.items, it)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return side{}, err
	}
	slices.SortFunc(s.items, func(a, b item) int {
		if a.side.IsDir != b.side.IsDir {
			if a.side.IsDir {
				return -1
			}
			return 1
		}
		return CompareNames(a.name, b.name)
	})
	return s, nil
}

// CompareNames orders names roughly as the page's localeCompare does: ignoring case first, then
// by exact bytes. The Commander's lists, Disk Usage and the agents' file tools all use it.
func CompareNames(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

// sameByHash reports whether two files have equal digests for a common hash type. It compares
// them the way rclone's check does, with operations.CheckHashes, using one hash type that both
// backends support. Different sizes settle the answer early, because on a local disk computing
// a digest means reading the whole file.
func sameByHash(ctx context.Context, a, b fs.Object) bool {
	if a == nil || b == nil {
		return false
	}
	if a.Size() >= 0 && b.Size() >= 0 && a.Size() != b.Size() {
		return false
	}
	// When the two sides share no hash type, CheckHashes returns hash.None and reports the files
	// as equal. They are not equal by hash, so they don't count here.
	equal, ht, err := operations.CheckHashes(ctx, a, b)
	return err == nil && equal && ht != hash.None
}
