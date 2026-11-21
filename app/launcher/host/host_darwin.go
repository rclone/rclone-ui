//go:build darwin

package host

import (
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/app/launcher/view/darwin"
)

// mod is the modifier key as drawn in the rows' shortcuts.
const mod = "⌘"

// activate makes the app active when an action opens a window from the launcher's panel, because
// the panel itself never activates the app.
var activate = darwin.ActivateApp

// newView creates the launcher's panel with Cocoa. It must run on the main thread.
func (h *Host) newView(ev view.Events) (view.View, error) { return darwin.New(ev) }

// ready runs once per run, when the core is ready. The launcher needs nothing more here.
func (h *Host) ready(view.View) {}

// clipboardPeek returns what the launcher may learn about the clipboard without macOS asking the
// user (pasteboard privacy, in macOS 15.4 and later), plus the clipboard's change count. That is
// only whether it holds a link, unless reading it is silent (on an older macOS, or when the user
// always allows it).
func (h *Host) clipboardPeek() (engine.Clip, string) {
	text, link, count := darwin.PeekClipboard()
	return engine.Clip{Text: text, Link: link}, count
}
