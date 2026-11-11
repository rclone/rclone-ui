// Package host builds the launcher for the UI role and lets the role drive it from any goroutine.
// It joins the launcher's engine, the store of the core's state, the core's APIs and this OS's
// view (see host_<os>.go). The launcher's state lives on the main thread, and Host moves each call
// there.
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
	App *application.App
	// Log is the UI's log. The launcher logs with src=launcher.
	Log *slog.Logger
	// Store is the one copy of the core's state, which the tray shows too.
	Store *corestate.Store
	APIs  *core.APIs
	// Production is true in a release build. A development build lets the web inspector open on
	// the launcher's page.
	Production bool
	// Open opens the window for a route. The route decides the window's name and size.
	Open func(url string) error
	// Reveal shows a path selected in its folder, and OpenURL opens a URL in the browser.
	Reveal, OpenURL func(string) error
	// Notify shows a desktop notification, and Quit runs the quit flow. Both may wait for the
	// user, so the launcher calls them on a goroutine of their own.
	Notify func(title, body string)
	Quit   func()
	// Acks are the pages' acknowledgements, where GNOME's extension records that it was enabled
	// once (see gnome.Ensure).
	Acks gnome.Acks
}

type Host struct {
	o        Options
	l        *launcher.Launcher
	shortcut *launcher.Shortcut
	log      *slog.Logger
	view     view.View // main thread
	// page is the launcher's view on Linux, which a page draws. It is nil elsewhere, and until
	// the view exists.
	page      atomic.Pointer[linux.View]
	readyOnce sync.Once
	// suspended counts the quits and updates under way (see Suspend). While it is above zero, the
	// launcher stays hidden and its shortcut and Show do nothing, because the core may stop at any
	// moment.
	suspended atomic.Int32
}

// New builds the launcher without its view, which Create makes once the app runs.
func New(o Options) *Host {
	h := &Host{o: o, log: o.Log.With("src", "launcher")}
	open := func(_, url string) {
		if err := o.Open(url); err != nil {
			h.log.Error("could not open a window", "route", url, "error", err)
		}
	}
	p := launcher.Platform{
		// Open takes the window's name and size from the route, so the name passed here is unused.
		OpenWindow: open,
		OpenFull:   open,
		Clipboard:  func(text string) { o.App.Clipboard.SetText(text) },
		// Show the path selected in its folder rather than opening it, because opening a program
		// (an .exe or an .app) would run it.
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
		// A toast shown as a dialog (when toasts aren't allowed) waits for the user, so it must not
		// run on the caller's thread.
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

// clipboardText returns the clipboard's text, or "". Call it off the main thread, because Wails
// reads the clipboard on the main thread.
func (h *Host) clipboardText() string {
	t, _ := h.o.App.Clipboard.Text()
	return t
}

// Create builds the view, hidden. If the platform can't create it, the launcher stays unavailable
// and the error explains why.
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

// Page returns the launcher's view on Linux, which a page draws (see linux.PageService). It
// returns nil on macOS and Windows, and until the view exists.
func (h *Host) Page() *linux.View {
	if h == nil {
		return nil
	}
	return h.page.Load()
}

// invokeSync is application.InvokeSync. Tests replace it, because no app runs in tests.
var invokeSync = application.InvokeSync

// mainSync runs fn on the main thread and waits for it. A panic in fn is returned as an error.
// Wails recovers a panic in the function passed to InvokeSync and ends the wait, but it passes the
// panic only to its PanicHandler. Without the recover here, the caller would never learn that
// Create failed.
func mainSync(fn func()) error {
	var err error
	invokeSync(recovering(fn, &err))
	return err
}

// recovering wraps fn so that a panic is stored in *err, with the stack.
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

// pressed handles the shortcut by toggling the launcher. On Wayland the compositor may pass an
// activation token for the press, which the window uses to take the focus. A press that hides the
// launcher doesn't keep its token, because the next Show (from the tray) would present a stale one.
func (h *Host) pressed(token string) { application.InvokeAsync(func() { h.toggle(token) }) }

// toggle does pressed's work on the main thread.
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

// Suspend hides the launcher and keeps it hidden, with its shortcut doing nothing, until Resume.
// It is used when a quit or an update is about to stop the core, and nothing should start in the
// meantime. Each Suspend has a matching Resume. (A quit that is asked for during an update's
// question has its own pair.)
func (h *Host) Suspend() {
	if h == nil {
		return
	}
	h.suspended.Add(1)
	application.InvokeAsync(h.l.Hide)
}

// Resume undoes a Suspend, after the quit or the update was cancelled or failed.
func (h *Host) Resume() {
	if h == nil {
		return
	}
	h.suspended.Add(-1)
}

// LanguageChanged draws the launcher again in the app's language, when the language setting
// changes.
func (h *Host) LanguageChanged() {
	if h == nil {
		return
	}
	application.InvokeAsync(h.l.LanguageChanged)
}

// SetShortcut replaces the launcher's global shortcut, and "" removes it. If the OS refuses the
// shortcut, SetShortcut returns an error and keeps the previous one.
func (h *Host) SetShortcut(shortcut string) error { return h.shortcut.Set(shortcut) }

// CoreReady runs this OS's one-time setup (see ready in host_<os>.go) the first time the core is
// ready in a run. The setup runs on the main thread, where the view lives. CoreReady doesn't read
// the core's state, because the store does that.
func (h *Host) CoreReady() {
	application.InvokeAsync(func() {
		h.readyOnce.Do(func() {
			if h.view != nil {
				h.ready(h.view)
			}
		})
	})
}
