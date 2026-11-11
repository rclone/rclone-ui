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

// Search walks dir under fs (in the form Clean returns) and everything below it. It emits the
// entries whose name contains term, ignoring case, as they are found. It uses the backend's ListR
// when there is one, and otherwise walks --checkers folders at a time. Entries whose name starts
// with a dot, and anything inside such a folder below dir, are left out because the page hides
// them. This isn't done with an rclone filter, because an include rule without a slash lets every
// folder through and turns off the backend's ListR (fs/filter/filter.go:347-358,685-695). A
// folder that can't be read does not stop the walk. Its error is returned at the end. The walk
// ends after max entries, whether they match or not, and then Search returns ErrWalkMax.
func Search(ctx context.Context, fsName, dir, term string, max int, fileDates bool, emit func([]Entry)) error {
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
			if !ok || rel == "" || hidden(rel) || !strings.Contains(folded(path.Base(rel)), want) {
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

// ErrWalkMax ends a search that read its most entries (Search's max) before it reached the end
// of the folder. The matches it found up to there were emitted, but there may be more.
var ErrWalkMax = errors.New("the search read its most entries and stopped")

// folded returns a name in the form that a search compares: composed (NFC) and lower case.
// Composing means that "café" typed with é as one character still finds a name that a Mac
// stored with the accent as a separate character.
func folded(s string) string { return strings.ToLower(norm.NFC.String(s)) }

// hidden reports whether a segment of the slash-separated rel starts with a dot.
func hidden(rel string) bool {
	for seg := range strings.SplitSeq(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
