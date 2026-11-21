//go:build windows

package host

import (
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	winview "github.com/rclone/rclone-ui/app/launcher/view/windows"
)

// mod is the modifier key as drawn in the rows' shortcuts.
const mod = "Ctrl+"

// activate passes the foreground to the window that an action opens. The launcher's window
// doesn't give the foreground back when it hides, so this brings the new window to the front as it
// appears.
var activate = winview.HandOff

// newView creates the launcher's window with Win32 and Direct2D. It must run on the main thread.
func (h *Host) newView(ev view.Events) (view.View, error) { return winview.New(ev) }

// ready runs on the main thread once per run, when the core is ready. It makes the window's
// panics go to the app's log.
func (h *Host) ready(view.View) { winview.SetLog(h.o.Log) }

// clipboardPeek returns what the launcher may learn about the clipboard. Here that is its text,
// because reading it doesn't prompt the user.
func (h *Host) clipboardPeek() (engine.Clip, string) {
	t := h.clipboardText()
	return engine.Clip{Text: t}, t
}
