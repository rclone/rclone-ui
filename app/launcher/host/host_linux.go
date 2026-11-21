//go:build linux

package host

import (
	"context"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/app/launcher/view/linux"
	"github.com/rclone/rclone-ui/app/launcher/view/linux/gnome"
)

// mod is the modifier key as drawn in the rows' shortcuts.
const mod = "Ctrl+"

// activate is nil, because the launcher's window takes the focus itself. There is no
// non-activating panel on Linux.
var activate func()

// newView creates the launcher's window: a window of the app whose page draws the launcher (see
// app/launcher/view/linux). It must run on the main thread.
func (h *Host) newView(ev view.Events) (view.View, error) {
	win := h.o.App.Window.NewWithOptions(linux.WindowOptions(!h.o.Production))
	plat, err := linux.NewPlatform(win)
	if err != nil {
		win.Close()
		return nil, err
	}
	after := func(d time.Duration, fn func()) { time.AfterFunc(d, fn) }
	v := linux.New(linux.Wrap(win), plat, ev, application.InvokeAsync, after)
	linux.Attach(win, v)
	h.page.Store(v)
	return v, nil
}

// ready runs once per run, when the core is ready. On GNOME, only a shell extension can place the
// launcher's window, so it makes sure that extension is installed and enabled. A Flatpak can talk
// to GNOME Shell, because the app doesn't start on GNOME without that permission (flatpakGate in
// app/app.go).
func (h *Host) ready(v view.View) {
	if lv, ok := v.(*linux.View); ok && lv.PlacedByShell() {
		go gnome.Ensure(context.Background(), h.o.Log, h.o.Acks)
	}
}

// clipboardPeek returns what the launcher may learn about the clipboard. Here that is its text,
// because reading it doesn't prompt the user.
func (h *Host) clipboardPeek() (engine.Clip, string) {
	t := h.clipboardText()
	return engine.Clip{Text: t}, t
}
