package operations

import (
	"context"
	"os"
	"testing"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/cmd/bisync/bilib"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"

	"github.com/rclone/rclone-ui/core/logs/rclonelog"
)

func TestBisyncTroubleOf(t *testing.T) {
	for _, c := range []struct {
		err     string
		trouble BisyncTrouble
		side    int
	}{
		{"", TroubleNone, 0},
		{"couldn't connect", TroubleNone, 0},
		{"bisync aborted", TroubleNone, 0},
		{"bisync needs a resync: bisync aborted", TroubleResync, 0},
		{"cannot find prior Path1 or Path2 listings: bisync aborted", TroubleResync, 0},
		{"too many deletes on Path1: bisync stopped", TroubleDeletes, 1},
		{"too many deletes on Path2: bisync stopped", TroubleDeletes, 2},
		{"too many deletes: bisync stopped", TroubleDeletes, 0},
	} {
		if trouble, side := BisyncTroubleOf(c.err); trouble != c.trouble || side != c.side {
			t.Errorf("%q: %q %d, want %q %d", c.err, trouble, side, c.trouble, c.side)
		}
	}
}

// A max-delete line counts only for a side whose path it names as rclone quotes it, so a path
// that is only a prefix of the named one doesn't count.
func TestDeletedSide(t *testing.T) {
	line := `too many deletes (>50%, 3 of 4) on Path2 "/data/ab". Run with --force if desired.`
	if got := deletedSide(line, "/x", "/data/ab"); got != 2 {
		t.Errorf("side %d, want 2", got)
	}
	if got := deletedSide(line, "/x", "/data/a"); got != 0 {
		t.Errorf("a prefix of the path: side %d", got)
	}
	if got := deletedSide(line, "/data/ab", "/y"); got != 0 {
		t.Errorf("the path on the other side: side %d", got)
	}
}

// bisync colours its critical error's line. It is heard without the colours, and only by a
// bisync that ran alone: with another one in flight, the line could be the other one's.
func TestHearCriticalError(t *testing.T) {
	rclonelog.Install(nil)
	ci := fs.GetConfig(context.Background())
	old := ci.LogLevel
	ci.LogLevel = fs.LogLevelNotice // the package's tests log only critical lines
	t.Cleanup(func() { ci.LogLevel = old })
	red := func(s string) string { return "\x1b[31m" + s + "\x1b[0m" }
	stop := hearBisync("/a/", "/b/", "/w/a..b")
	fs.Errorf(nil, red("Bisync critical error: %v"), "boom")
	fs.Errorf("Safety abort", "too many deletes (>50%%, 3 of 4) on Path2 %q. Run with --force if desired.", "/b/")
	heard := stop()
	if heard.critical != "boom" || heard.deletedSide != 2 {
		t.Errorf("alone: heard %+v", heard)
	}

	first := hearBisync("/a/", "/b/", "/w/a..b")
	second := hearBisync("/c/", "/d/", "/w/c..d")
	fs.Errorf(nil, red("Bisync critical error: %v"), "whose")
	if heard := second(); heard.critical != "" {
		t.Errorf("a bisync that overlapped another kept %q", heard.critical)
	}
	if heard := first(); heard.critical != "" {
		t.Errorf("a bisync that overlapped another kept %q", heard.critical)
	}

	// A critical line that names a run's listings is that run's, even with others in flight.
	first = hearBisync("/a/", "/b/", "/w/a..b")
	second = hearBisync("/c/", "/d/", "/w/c..d")
	fs.Errorf(nil, red("Bisync critical error: %v"), "empty prior Path1 listing: /w/c..d.path1.lst")
	if heard := first(); heard.critical != "" {
		t.Errorf("another run's listing line was heard by this one: %q", heard.critical)
	}
	if heard := second(); heard.critical != "empty prior Path1 listing: /w/c..d.path1.lst" {
		t.Errorf("a run's own listing line: %q", heard.critical)
	}
}

// An empty listing is read back as a merge to run (prior) or a side that lost every file
// (current).
func TestEmptyListings(t *testing.T) {
	p := Plan{}
	for _, c := range []struct {
		critical string
		trouble  BisyncTrouble
		side     int
	}{
		{"empty prior Path1 listing: /w/a..b.path1.lst", TroubleMerge, 0},
		{"empty prior Path2 listing: /w/a..b.path2.lst", TroubleMerge, 0},
		{"empty current Path1 listing: /w/a..b.path1.lst-new", TroubleEmptied, 1},
		{"empty current Path2 listing: /w/a..b.path2.lst-new", TroubleEmptied, 2},
	} {
		err := p.bisyncError(context.Background(), bisync.ErrBisyncAborted, nil, nil, heardBisync{critical: c.critical})
		if trouble, side := BisyncTroubleOf(err.Error()); trouble != c.trouble || side != c.side {
			t.Errorf("%q: %v read as %q %d", c.critical, err, trouble, side)
		}
	}
}

// An abort carries the critical error that bisync logged. It needs a resync once bisync has set
// its listings aside, and is an ordinary failure while they are there.
func TestBisyncErrorKeepsTheReason(t *testing.T) {
	ctx := context.Background()
	work := t.TempDir()
	a, err := cache.Get(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, err := cache.Get(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := Plan{Bisync: map[string]any{"workdir": work}}
	heard := heardBisync{critical: "failed to open source object"}
	got := p.bisyncError(ctx, bisync.ErrBisyncAborted, a, b, heard)
	if got.Error() != "bisync needs a resync: failed to open source object: bisync aborted" {
		t.Errorf("without listings: %v", got)
	}
	if trouble, _ := BisyncTroubleOf(got.Error()); trouble != TroubleResync {
		t.Errorf("without listings: trouble %q", trouble)
	}
	base := bilib.BasePath(ctx, work, a, b)
	for _, l := range []string{base + ".path1.lst", base + ".path2.lst"} {
		if err := os.WriteFile(l, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got = p.bisyncError(ctx, bisync.ErrBisyncAborted, a, b, heard)
	if got.Error() != "bisync aborted: failed to open source object" {
		t.Errorf("with listings: %v", got)
	}
	if trouble, _ := BisyncTroubleOf(got.Error()); trouble != TroubleNone {
		t.Errorf("with listings: trouble %q", trouble)
	}
}

// A resync's abort carries its reason too, and is never read as needing a resync.
func TestResyncAbortKeepsTheReason(t *testing.T) {
	p := Plan{Bisync: map[string]any{"resync": true}}
	got := p.bisyncError(context.Background(), bisync.ErrBisyncAborted, nil, nil, heardBisync{critical: "permission denied"})
	if got.Error() != "bisync aborted: permission denied" {
		t.Errorf("got %v", got)
	}
}
