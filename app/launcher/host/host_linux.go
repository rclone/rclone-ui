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

const mod = "Ctrl+"

var activate func()

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

func (h *Host) ready(v view.View) {
	if lv, ok := v.(*linux.View); ok && lv.PlacedByShell() {
		go gnome.Ensure(context.Background(), h.o.Log, h.o.Acks)
	}
}

func (h *Host) clipboardPeek() (engine.Clip, string) {
	t := h.clipboardText()
	return engine.Clip{Text: t}, t
}
