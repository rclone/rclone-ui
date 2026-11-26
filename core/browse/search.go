package browse

import (
	"context"
	"errors"
	"path"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/walk"
	"golang.org/x/text/unicode/norm"
)

// Dot entries are left out here, not with an rclone filter, because an include rule without a
// slash lets every folder through and turns off the backend's ListR
// (fs/filter/filter.go:347-358,685-695).
func Search(ctx context.Context, fsName, dir, term string, max int, fileDates, hidden bool, emit func([]Entry)) error {
	fsName, dir = Clean(fsName, dir)
	f, err := getFs(ctx, fsName)
	if err != nil {
		return err
	}
	mk := newEntryMaker(ctx, f, dir, fileDates)
	want := folded(term)
	prefix := ""
	if dir != "" {
		prefix = dir + "/"
	}
	var mu sync.Mutex
	seen := map[string]struct{}{}
	walked := 0
	err = walk.ListR(ctx, f, dir, true, -1, walk.ListAll, func(entries fs.DirEntries) error {
		mu.Lock()
		defer mu.Unlock()
		full := len(entries) >= max-walked
		entries = entries[:min(len(entries), max-walked)]
		walked += len(entries)
		var found []Entry
		for _, e := range entries {
			rel, ok := strings.CutPrefix(e.Remote(), prefix)
			if !ok || rel == "" || (!hidden && dotted(rel)) || !strings.Contains(folded(path.Base(rel)), want) {
				continue
			}
			if _, dup := seen[e.Remote()]; dup {
				continue
			}
			seen[e.Remote()] = struct{}{}
			found = append(found, mk.entry(ctx, e))
		}
		if len(found) > 0 {
			sortByPath(found)
			emit(found)
		}
		if full {
			return errStop
		}
		return ctx.Err()
	})
	if errors.Is(err, errStop) {
		return ErrWalkMax
	}
	return err
}

var ErrWalkMax = errors.New("the search read its most entries and stopped")

// folded returns a name in the form that a search compares: composed (NFC) and lower case.
// Composing means that "café" typed with é as one character still finds a name that a Mac
// stored with the accent as a separate character.
func folded(s string) string { return strings.ToLower(norm.NFC.String(s)) }

func dotted(rel string) bool {
	for seg := range strings.SplitSeq(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
