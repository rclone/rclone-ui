package app

import (
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
)

func TestTrayTransfersLabel(t *testing.T) {
	for _, c := range []struct {
		items map[string]bus.TransferProgress
		want  string
	}{
		{nil, ""},
		{map[string]bus.TransferProgress{"t1": {Bytes: 42, TotalBytes: 100}}, "History (1 running · 42%)"},
		{map[string]bus.TransferProgress{"t1": {Bytes: 10, TotalBytes: 100}, "t2": {Bytes: 290, TotalBytes: 300}}, "History (2 running · 75%)"},
		{map[string]bus.TransferProgress{"t1": {}}, "History (1 running)"},
		// A watcher's runs are left out.
		{map[string]bus.TransferProgress{"t1": {Bytes: 42, TotalBytes: 100}, "w": {Bytes: 0, TotalBytes: 100, Watcher: true}}, "History (1 running · 42%)"},
		{map[string]bus.TransferProgress{"w": {Watcher: true}}, ""},
	} {
		if got := trayTransfersLabel(c.items); got != c.want {
			t.Errorf("%v: %q, want %q", c.items, got, c.want)
		}
	}
}
