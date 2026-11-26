//go:build windows

package host

import (
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	winview "github.com/rclone/rclone-ui/app/launcher/view/windows"
)

const mod = "Ctrl+"

var activate = winview.HandOff

func (h *Host) newView(ev view.Events) (view.View, error) { return winview.New(ev) }

func (h *Host) ready(view.View) { winview.SetLog(h.o.Log) }

func (h *Host) clipboardPeek() (engine.Clip, string) {
	t := h.clipboardText()
	return engine.Clip{Text: t}, t
}
