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

type Comparison struct {
	Pairs  []Pair
	Capped bool
}

func Compare(ctx context.Context, left, right string, fileDates, hidden bool) (Comparison, error) {
	var (
		fss   [2]fs.Fs
		sides [2]side
		errs  [2]error
		wg    sync.WaitGroup
	)
	locs := [2]string{left, right}
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
				sides[i], err = listSide(ctx, fss[i], fileDates, hidden)
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
	byClass := map[Class][]Pair{}
	add := func(p Pair) { byClass[p.Class] = append(byClass[p.Class], p) }
	for i := range l.items {
		li := &l.items[i]
		ri := rightByName[li.name]
		switch {
		case ri == nil:
			add(Pair{Class: OnlyLeft, Name: li.name, Left: &li.side})
		case sameByHash(ctx, li.obj, ri.obj):
			add(Pair{Class: SameByHash, Name: li.name, Left: &li.side, Right: &ri.side})
		default:
			add(Pair{Class: SameByName, Name: li.name, Left: &li.side, Right: &ri.side})
		}
		if ri != nil {
			ri.paired = true
		}
	}
	for i := range r.items {
		if ri := &r.items[i]; !ri.paired {
			add(Pair{Class: OnlyRight, Name: ri.name, Right: &ri.side})
		}
	}
	return Comparison{Pairs: slices.Concat(byClass[OnlyLeft], byClass[OnlyRight], byClass[SameByName], byClass[SameByHash]), Capped: l.capped || r.capped}, nil
}

type side struct {
	items  []item
	capped bool
}

type item struct {
	name   string
	side   Side
	obj    fs.Object
	paired bool
}

func listSide(ctx context.Context, f fs.Fs, fileDates, hidden bool) (side, error) {
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
			if e.Remote() == "" || (!hidden && strings.HasPrefix(name, ".")) {
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

func CompareNames(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

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
