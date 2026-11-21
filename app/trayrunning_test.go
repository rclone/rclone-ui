package app

import (
	"context"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
)

func TestRunningItems(t *testing.T) {
	none := func(string, runningAction) {}
	if items := runningItems(nil, nil, none); len(items) != 0 {
		t.Fatalf("nothing runs: %+v", items)
	}
	ms := []mounts.MountRow{
		{ID: "m1", Source: "gdrive:Photos", MountPoint: "/Volumes/Photos", State: "running"},
		{ID: "m2", Source: "box:", MountPoint: "/Volumes/box", State: "starting"},
	}
	ss := []serves.ServeRow{{ID: "s1", Type: "webdav", Addr: "127.0.0.1:8080", State: "running"}}
	var ran []string
	items := runningItems(ms, ss, func(name string, _ runningAction) { ran = append(ran, name) })
	if len(items) != 2 || items[0].Label != "Mounts (2)" || items[1].Label != "Serves (1)" {
		t.Fatalf("items %+v", items)
	}
	m := items[0].Children
	if len(m) != 4 || m[0].Label != "gdrive:Photos → /Volumes/Photos" || m[1].Label != "box: → /Volumes/box (starting)" ||
		!m[2].Separator || m[3].Label != "Unmount All" {
		t.Fatalf("mounts %+v", m)
	}
	if open := m[1].Children[0]; open.Label != "Open" || !open.Disabled {
		t.Fatalf("a starting mount's Open %+v", open)
	}
	if m[0].Children[0].Disabled || m[0].Children[1].Label != "Unmount" {
		t.Fatalf("a running mount's items %+v", m[0].Children)
	}
	var action runningAction
	runningItems(ms, ss, func(_ string, a runningAction) { action = a })[0].Children[1].Children[0].OnClick()
	var revealed string
	_ = action(context.Background(), runningClients{reveal: func(p string) error { revealed = p; return nil }})
	if revealed != "/Volumes/box" {
		t.Fatalf("Open revealed %q", revealed)
	}
	m[1].Children[0].OnClick()
	m[3].OnClick()
	s := items[1].Children
	if len(s) != 1 || s[0].Label != "WEBDAV 127.0.0.1:8080" || s[0].Children[0].Label != "Copy Address" || s[0].Children[1].Label != "Stop" {
		t.Fatalf("serves %+v", s)
	}
	s[0].Children[1].OnClick()
	if got := strings.Join(ran, ","); got != "open m2,unmount all,stop s1" {
		t.Fatalf("actions %s", got)
	}
}

func TestShortcutLabel(t *testing.T) {
	for _, c := range []struct{ shortcut, goos, want string }{
		{"CmdOrCtrl+Shift+/", "darwin", "Command + Shift + /"},
		{"CmdOrCtrl+Shift+/", "windows", "Control + Shift + /"},
		{"Command+Shift+/", "darwin", "Command + Shift + /"},
		{"Ctrl+Alt+K", "linux", "Control + Alt + K"},
		{"Alt+Space", "darwin", "Option + Space"},
	} {
		if got := shortcutLabel(c.shortcut, c.goos); got != c.want {
			t.Errorf("%s on %s: %q, want %q", c.shortcut, c.goos, got, c.want)
		}
	}
}
