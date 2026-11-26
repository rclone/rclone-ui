package host

import (
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher"
	"github.com/rclone/rclone-ui/app/launcher/state"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/app/launcher/view/linux"
	"github.com/rclone/rclone-ui/app/launcher/view/linux/gnome"
	"github.com/rclone/rclone-ui/core"
)

type Options struct {
	App             *application.App
	Log             *slog.Logger
	Store           *corestate.Store
	APIs            *core.APIs
	Production      bool
	Open            func(url string) error
	Reveal, OpenURL func(string) error
	Notify          func(title, body string)
	Quit            func()
	Acks            gnome.Acks
}

type Host struct {
	o         Options
	l         *launcher.Launcher
	shortcut  *launcher.Shortcut
	log       *slog.Logger
	view      view.View
	page      atomic.Pointer[linux.View]
	readyOnce sync.Once
	suspended atomic.Int32
}

func New(o Options) *Host {
	h := &Host{o: o, log: o.Log.With("src", "launcher")}
	open := func(_, url string) {
		if err := o.Open(url); err != nil {
			h.log.Error("could not open a window", "route", url, "error", err)
		}
	}
	p := launcher.Platform{
		OpenWindow: open,
		OpenFull:   open,
		Clipboard:  func(text string) { o.App.Clipboard.SetText(text) },
		Reveal: func(path string) {
			if err := o.Reveal(path); err != nil {
				h.log.Error("could not show a path", "path", path, "error", err)
			}
		},
		OpenURL: func(url string) {
			if err := o.OpenURL(url); err != nil {
				h.log.Error("could not open a URL", "url", url, "error", err)
			}
		},
		Notify:   func(title, body string) { go o.Notify(title, body) },
		Activate: activate,
		Quit:     func() { go o.Quit() },
		Main:     application.InvokeAsync,
		MainSync: func(fn func()) {
			if err := mainSync(fn); err != nil {
				h.log.Error("the launcher failed on the main thread", "error", err)
			}
		},
		Mod:           mod,
		ClipboardText: h.clipboardText,
		ClipboardPeek: h.clipboardPeek,
	}
	h.l = launcher.New(p, h.log, state.New(o.Store, coreAPIs{o.APIs}), o.APIs.Launcher)
	h.shortcut = launcher.NewShortcut(o.App, h.log, h.pressed)
	return h
}

func (h *Host) clipboardText() string {
	t, _ := h.o.App.Clipboard.Text()
	return t
}

func (h *Host) Create() error {
	var err error
	if perr := mainSync(func() {
		v, e := h.newView(h.l.Events())
		if e != nil {
			err = e
			return
		}
		h.view = v
		h.l.Attach(v)
		if md, ok := v.(interface{ Mode() string }); ok {
			h.log.Info("launcher window", "mode", md.Mode())
		}
	}); perr != nil {
		return perr
	}
	return err
}

func (h *Host) Page() *linux.View {
	if h == nil {
		return nil
	}
	return h.page.Load()
}

var invokeSync = application.InvokeSync

// Wails recovers a panic in the function passed to InvokeSync and ends the wait, but it passes the
// panic only to its PanicHandler. Without the recover here, the caller would never learn that
// Create failed.
func mainSync(fn func()) error {
	var err error
	invokeSync(recovering(fn, &err))
	return err
}

func recovering(fn func(), err *error) func() {
	return func() {
		defer func() {
			if r := recover(); r != nil {
				*err = fmt.Errorf("panic: %v\n%s", r, debug.Stack())
			}
		}()
		fn()
	}
}

func (h *Host) pressed(token string) { application.InvokeAsync(func() { h.toggle(token) }) }

func (h *Host) toggle(token string) {
	if h.suspended.Load() > 0 {
		return
	}
	if a, ok := h.view.(view.Activator); ok && token != "" && !h.l.Visible() {
		a.SetActivationToken(token)
	}
	h.l.Toggle()
}

func (h *Host) Show() {
	application.InvokeAsync(func() {
		if h.suspended.Load() > 0 {
			return
		}
		h.l.Show()
	})
}

func (h *Host) Suspend() {
	if h == nil {
		return
	}
	h.suspended.Add(1)
	application.InvokeAsync(h.l.Hide)
}

func (h *Host) Resume() {
	if h == nil {
		return
	}
	h.suspended.Add(-1)
}

func (h *Host) LanguageChanged() {
	if h == nil {
		return
	}
	application.InvokeAsync(h.l.LanguageChanged)
}

func (h *Host) SetShortcut(shortcut string) error { return h.shortcut.Set(shortcut) }

func (h *Host) SetStaysOpen(stays bool) { h.l.SetStaysOpen(stays) }

func (h *Host) CoreReady() {
	application.InvokeAsync(func() {
		h.readyOnce.Do(func() {
			if h.view != nil {
				h.ready(h.view)
			}
		})
	})
}
