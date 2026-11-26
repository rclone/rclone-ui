//go:build darwin

package host

import (
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/app/launcher/view/darwin"
)

const mod = "⌘"

var activate = darwin.ActivateApp

func (h *Host) newView(ev view.Events) (view.View, error) { return darwin.New(ev) }

func (h *Host) ready(view.View) {}

func (h *Host) clipboardPeek() (engine.Clip, string) {
	text, link, count := darwin.PeekClipboard()
	return engine.Clip{Text: text, Link: link}, count
}
