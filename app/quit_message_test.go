package app

import (
	"testing"

	"github.com/rclone/rclone-ui/core"
)

func TestQuitMessage(t *testing.T) {
	const tail = " won't run. They start again when you open it."
	copying := core.BusyList{
		Items:   []core.BusyItem{{Kind: "transfer", Label: "Copy /a → /b", Detail: "Runs again when Rclone UI starts."}},
		Running: core.Running{Transfers: 1},
	}
	several := core.BusyList{
		Items: []core.BusyItem{
			{Kind: "transfer", Label: "Copy /a → /b"},
			{Kind: "mount", Label: "Mount gdrive: at /m"},
			{Kind: "tunnel", Label: "The remote tunnel"},
		},
		Running: core.Running{Transfers: 1, Mounts: 1, Tunnel: true},
	}
	for _, c := range []struct {
		busy                core.BusyList
		watchers, schedules int
		want                string
	}{
		{core.BusyList{}, 0, 0, ""},
		{core.BusyList{}, 1, 0, "While Rclone UI is closed, your watcher won't run. It starts again when you open it."},
		{core.BusyList{}, 0, 3, "While Rclone UI is closed, your 3 schedules" + tail},
		{core.BusyList{}, 1, 2, "While Rclone UI is closed, your watcher and 2 schedules" + tail},
		{core.BusyList{}, 2, 3, "While Rclone UI is closed, your 2 watchers and 3 schedules" + tail},
		{core.BusyList{}, 2, 1, "While Rclone UI is closed, your 2 watchers and 1 schedule" + tail},
		{core.BusyList{}, 0, 1, "While Rclone UI is closed, your schedule won't run. It starts again when you open it."},
		{copying, 0, 0, "A transfer will be stopped:\n\n• Copy /a → /b (Runs again when Rclone UI starts.)"},
		{several, 1, 1, "A transfer, a mount and the remote tunnel will be stopped:\n\n• Copy /a → /b\n• Mount gdrive: at /m\n" +
			"• The remote tunnel\n\nWhile Rclone UI is closed, your watcher and 1 schedule" + tail},
	} {
		if got := quitMessage(c.busy, c.watchers, c.schedules); got != c.want {
			t.Errorf("%+v %d %d:\n got %q\nwant %q", c.busy, c.watchers, c.schedules, got, c.want)
		}
	}
}
