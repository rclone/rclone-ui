package linux

import (
	"math"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

func WindowOptions(devTools bool) application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		Name:                       "Launcher",
		Title:                      Title,
		URL:                        "/launcher",
		Hidden:                     true,
		Width:                      int(view.Width),
		Height:                     int(math.Ceil(view.FullHeight())),
		Frameless:                  true,
		DisableResize:              true,
		AlwaysOnTop:                true,
		EnableFileDrop:             true,
		Zoom:                       1,
		ZoomControlEnabled:         false,
		DevToolsEnabled:            devTools,
		DefaultContextMenuDisabled: !devTools,
	}
}

func Wrap(w *application.WebviewWindow) Window { return wailsWindow{w} }

type wailsWindow struct{ w *application.WebviewWindow }

func (w wailsWindow) Show()                     { w.w.Show() }
func (w wailsWindow) Hide()                     { w.w.Hide() }
func (w wailsWindow) SetSize(width, height int) { w.w.SetSize(width, height) }

func (w wailsWindow) Send(name string, data any) {
	w.w.DispatchWailsEvent(&application.CustomEvent{Name: name, Data: data})
}

func Attach(w *application.WebviewWindow, v *View) {
	w.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) { v.Focused() })
	w.OnWindowEvent(events.Common.WindowLostFocus, func(*application.WindowEvent) { v.FocusLost() })
	w.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) { v.Moved() })
	w.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		v.Dropped(e.Context().DroppedFiles())
	})
	w.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		v.Closed()
	})
}
