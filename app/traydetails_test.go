package app

import (
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/app/tray"
	"github.com/rclone/rclone-ui/core/bus"
)

func TestTrayTransferDetails(t *testing.T) {
	eta := int64(120)
	live := map[string]bus.TransferProgress{
		"b":       {Bytes: 25, TotalBytes: 100, Speed: 1024, Eta: &eta, Transferring: []bus.TransferringFile{{Name: "Music/second.mp3", Bytes: 25, Size: 100, Speed: 1024}}},
		"a":       {Bytes: 50, TotalBytes: 100, Speed: 2048, Eta: &eta, Transferring: []bus.TransferringFile{{Name: "Video/first.mov", Bytes: 50, Size: 100, Speed: 2048}}},
		"watcher": {Watcher: true, Bytes: 999, TotalBytes: 1000, Transferring: []bus.TransferringFile{{Name: "hidden"}}},
	}
	d := trayTransferDetails(live)
	if d.Summary != "Transfers (2) · 37% · 3 KB/s · 2 min left" {
		t.Fatalf("summary %q", d.Summary)
	}
	if len(d.Files) != 2 || d.Files[0].Label != "first.mov · 50% · 2 KB/s" || d.Files[0].Path != "Video/first.mov" || d.Files[1].Label != "second.mp3 · 25% · 1 KB/s" {
		t.Fatalf("files %+v", d.Files)
	}
	// Reading progress must not reorder or truncate the source snapshot.
	p := live["a"]
	p.Transferring = []bus.TransferringFile{{Name: "z"}, {Name: "a"}}
	live["a"] = p
	d = trayTransferDetails(live)
	if d.Files[0].Label != "a" || live["a"].Transferring[0].Name != "z" {
		t.Fatal("unstable order or modified snapshot")
	}
	delete(live, "a")
	delete(live, "b")
	if d := trayTransferDetails(live); d.Summary != "" || len(d.Files) != 0 {
		t.Fatalf("watcher-only state %+v", d)
	}
	if d := trayTransferDetails(nil); d.Summary != "" {
		t.Fatal("ended transfers left stale details")
	}
}

func TestTrayTransferDetailsBounds(t *testing.T) {
	files := make([]bus.TransferringFile, 10)
	for i := range files {
		files[i] = bus.TransferringFile{Name: "folder/" + strings.Repeat("Ж", 70) + ".mov", Bytes: 200, Size: 100}
	}
	d := trayTransferDetails(map[string]bus.TransferProgress{"t": {Transferring: files}})
	if len(d.Files) != tray.MaxTransferFiles || d.More != 5 {
		t.Fatalf("unbounded details %+v", d)
	}
	if !strings.Contains(d.Files[0].Label, "100%") || !strings.Contains(d.Files[0].Label, "…") || len([]rune(strings.Split(d.Files[0].Label, " · ")[0])) != 48 {
		t.Fatalf("unbounded filename or percent: %q", d.Files[0].Label)
	}
	if d.Files[0].Path != files[0].Name {
		t.Fatal("full path missing from tooltip")
	}
	if compactTrayName("a\nb\tc\rd") != "a b c d" {
		t.Fatal("filename injected native menu lines")
	}
	d = trayTransferDetails(map[string]bus.TransferProgress{"t": {Transferring: []bus.TransferringFile{{Name: "unknown", Size: -1, Pct: 100, Bytes: 10}}}})
	if d.Files[0].Label != "unknown" || strings.Contains(d.Summary, "%") || strings.Contains(d.Summary, "left") {
		t.Fatalf("invented progress: %+v", d)
	}
}
