package core

import (
	"testing"

	"github.com/rclone/rclone-ui/core/transfers"
)

// A running transfer from the pages starts again after an update. A schedule's run runs again at
// the next start, whatever stops it. A retry of a scheduled run is the user's, and keeps neither.
func TestBusyDetail(t *testing.T) {
	page := transfers.Origin{Kind: transfers.OriginPage}
	schedule := transfers.Origin{Kind: transfers.OriginSchedule, ID: "s1", Name: "Nightly"}
	for _, c := range []struct {
		tr   transfers.Transfer
		want string
	}{
		{transfers.Transfer{State: transfers.StateRunning, Operation: "copy", Origin: page}, "Starts again after an update."},
		{transfers.Transfer{State: transfers.StateRunning, Operation: "copy", Origin: schedule},
			"Runs again when Rclone UI starts."},
		{transfers.Transfer{State: transfers.StateRunning, Operation: "bisync", Origin: schedule},
			"Runs again when Rclone UI starts."},
		{transfers.Transfer{State: transfers.StateRunning, Operation: "copy", Origin: schedule, RetryOf: "t1"}, ""},
		{transfers.Transfer{State: transfers.StateRunning, Operation: "bisync", Origin: page}, ""},
		{transfers.Transfer{State: transfers.StateRunning, Operation: "bisync",
			Origin: transfers.Origin{Kind: transfers.OriginWatcher, ID: "w1"}}, ""},
	} {
		if got := busyDetail(c.tr); got != c.want {
			t.Errorf("%+v: %q, want %q", c.tr, got, c.want)
		}
	}
}

// Phrase names what runs in one line, the same for a question and its answer. Done says what a
// stop stopped, or that nothing was running.
func TestRunningPhrase(t *testing.T) {
	for _, c := range []struct {
		r    Running
		want string
	}{
		{Running{}, ""},
		{Running{Mounts: 1}, "a mount"},
		{Running{Tunnel: true}, "the remote tunnel"},
		{Running{Transfers: 2, Serves: 1}, "2 transfers and a serve"},
		{Running{Transfers: 2, Serves: 1, Mounts: 3}, "2 transfers, a serve and 3 mounts"},
		{Running{Transfers: 1, Mounts: 2, Tunnel: true}, "a transfer, 2 mounts and the remote tunnel"},
	} {
		if got := c.r.Phrase().String(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.r, got, c.want)
		}
	}
	if got := (StopSummary{Running{Transfers: 2, Serves: 1, Mounts: 3}}).Done().String(); got != "Stopped 2 transfers, a serve and 3 mounts." {
		t.Errorf("done: %q", got)
	}
	if got := (StopSummary{}).Done().String(); got != "Nothing was running." {
		t.Errorf("done with nothing: %q", got)
	}
}
