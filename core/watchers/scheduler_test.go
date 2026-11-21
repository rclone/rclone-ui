package watchers

import (
	"testing"

	"github.com/rclone/rclone-ui/core/transfers"
)

// A watcher's run leaves no trace in History when it changed nothing, or when bisync only asked
// for a merge, which the watcher runs at once. A Resync or a Force that the user asked for is
// kept, even when it changed nothing, and so is any other end.
func TestQuiet(t *testing.T) {
	merge := "bisync needs a merge: empty prior Path1 listing: /w/a..b.path1.lst: bisync aborted"
	o := (*owner)(nil)
	for _, c := range []struct {
		mode   mode
		resync bool
		state  transfers.State
		err    string
		stats  *transfers.Summary
		quiet  bool
	}{
		{modeNormal, false, transfers.StateCompleted, "", &transfers.Summary{Checks: 3}, true},
		{modeNow, true, transfers.StateCompleted, "", &transfers.Summary{Checks: 3}, true}, // the first merge
		{modeNormal, false, transfers.StateCompleted, "", &transfers.Summary{Transfers: 1}, false},
		{modeNormal, false, transfers.StateCompleted, "", &transfers.Summary{Deletes: 1}, false},
		{modeResync, true, transfers.StateCompleted, "", &transfers.Summary{Checks: 3}, false},
		{modeForce, false, transfers.StateCompleted, "", &transfers.Summary{}, false},
		{modeNormal, false, transfers.StateFailed, merge, &transfers.Summary{}, true},
		{modeNormal, false, transfers.StateFailed, merge, &transfers.Summary{Transfers: 1}, false},
		{modeNormal, true, transfers.StateFailed, merge, &transfers.Summary{}, false},
		{modeForce, false, transfers.StateFailed, merge, &transfers.Summary{}, false},
		{modeNormal, false, transfers.StateFailed, "couldn't connect", &transfers.Summary{}, false},
		{modeNormal, false, transfers.StateFailed, "every file was deleted on Path1 since the last sync: empty current Path1 listing", &transfers.Summary{}, false},
		{modeNormal, false, transfers.StateStopped, "", &transfers.Summary{}, false},
	} {
		r := &run{Mode: c.mode, Data: runData{resync: c.resync}}
		if got := o.Quiet(r, c.state, c.err, c.stats); got != c.quiet {
			t.Errorf("mode %d resync %v, %s %q %+v: quiet %v", c.mode, c.resync, c.state, c.err, c.stats, got)
		}
	}
}
