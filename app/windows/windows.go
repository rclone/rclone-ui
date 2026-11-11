// Package windows opens and finds the app's windows, and sets their sizes and placement. A route
// decides its window's name and shape (see ForRoute). Opening a route whose window is already open
// focuses that window and passes it the route. Standard windows cascade around the screen's
// centre.
package windows

import (
	"context"
	"errors"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/rclone/rclone-ui/app/interaction"
)

// The events that a window receives alone.
const (
	// EventCloseAsked tells a window that the user asked to close it while its page guards the
	// close (see GuardClose). The page asks the user, and closes the window itself.
	EventCloseAsked = "window:close"
	// EventRoute tells an open window to switch to a route, which is the event's data. Opening a
	// route whose window is already open sends it (see Open).
	EventRoute = "window:route"
)

// Default size of a standard window.
const (
	DefaultWidth  = 840
	DefaultHeight = 725
)

type Manager struct {
	app        *application.App
	log        *slog.Logger
	production bool
	mu         sync.Mutex
	// Opened is called with the name of each of the app's own windows as it opens ("Commander").
	// The shell sets it once, before any window opens.
	Opened func(name string)
	// closing is set when the app is quitting. After that, no window shows again.
	closing atomic.Bool

	themeMu sync.Mutex
	themes  map[string]string // each window's theme, as its page set it with SetTheme
	theme   string            // the theme a page set last, which new windows start with

	guardMu sync.Mutex
	guarded map[string]bool // the windows whose pages asked to confirm a close (GuardClose)
}

func New(app *application.App, log *slog.Logger, production bool) *Manager {
	m := &Manager{app: app, log: log, production: production, themes: map[string]string{}, guarded: map[string]bool{}}
	if runtime.GOOS == "windows" {
		// Windows are created with an explicit theme (see base), so that Wails doesn't reapply
		// the system's theme on every change. Windows that follow the system are updated here
		// instead.
		app.Event.OnApplicationEvent(events.Windows.SystemThemeChanged, func(*application.ApplicationEvent) {
			m.reapplyThemes()
		})
	}
	return m
}

// Closing tells the Manager that the app is quitting. From then on, no window opens or shows, not
// even one whose page is still loading.
func (m *Manager) Closing() { m.closing.Store(true) }

func (m *Manager) Get(name string) (application.Window, bool) {
	return m.app.Window.GetByName(name)
}

// Caller returns the window whose page made a bound call, from the call's context. It returns
// false when the call didn't come from a window.
func Caller(ctx context.Context) (application.Window, bool) {
	w, ok := ctx.Value(application.WindowKey).(application.Window)
	return w, ok && w != nil
}

// dispatcher is a window that can receive an event of its own.
type dispatcher interface {
	DispatchWailsEvent(event *application.CustomEvent)
}

// route tells an open window to switch to url. The event goes to that window alone, because
// Wails' Emit would send it to every window.
func route(w dispatcher, url string) {
	w.DispatchWailsEvent(&application.CustomEvent{Name: EventRoute, Data: url})
}

// reuse brings an open window to the front and passes it the route. It returns false when no such
// window is open.
func (m *Manager) reuse(name, url string) bool {
	w, ok := m.app.Window.GetByName(name)
	if !ok {
		return false
	}
	if url != "" {
		route(w, url)
	}
	if w.IsMinimised() {
		w.UnMinimise()
	}
	w.Show()
	w.Focus()
	return true
}

func (m *Manager) primary() (*application.Screen, error) {
	if s := m.app.Screen.GetPrimary(); s != nil {
		return s, nil
	}
	if all := m.app.Screen.GetAll(); len(all) > 0 {
		return all[0], nil
	}
	return nil, errors.New("no screen found")
}

// openCount returns the number of visible windows that a new window cascades from. The startup
// window doesn't count.
func (m *Manager) openCount() int {
	n := 0
	for _, w := range m.app.Window.GetAll() {
		if name := w.Name(); name != Startup && w.IsVisible() {
			n++
		}
	}
	return n
}

// Open opens the window for a route, such as "/remotes?action=create", in the shape that the route
// gives it (see ForRoute). If the window is already open, Open focuses it and passes it the route.
func (m *Manager) Open(url string) error {
	name, shape := ForRoute(url)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing.Load() {
		return errors.New("the app is quitting")
	}
	if m.reuse(name, url) {
		return nil
	}
	screen, err := m.primary()
	if err != nil {
		return err
	}
	opts := m.base(name, url)
	opts.Screen = screen
	switch shape {
	case Full:
		m.openFull(opts, screen)
	case Small:
		m.openSmall(opts, screen)
	default:
		m.openStandard(opts, screen)
	}
	// Only the app's own windows are named: a route from outside can't put its text there.
	if _, own := titleOf(name); own && m.Opened != nil {
		m.Opened(name)
	}
	return nil
}

func (m *Manager) openStandard(opts application.WebviewWindowOptions, screen *application.Screen) {
	w, h := DefaultWidth, DefaultHeight
	minW, minH := 650, 500
	maxW, maxH := 1000, 1000
	switch runtime.GOOS {
	case "windows":
		// WebView2 renders at a forced device scale factor of 1 (see app.go), so these sizes are
		// in physical pixels. Wails expects all of them in DIPs, including the minimum and the
		// maximum (it scales those in WM_GETMINMAXINFO).
		w, h = unscale(w, screen), unscale(h, screen)
		minW, minH = unscale(minW, screen), unscale(minH, screen)
		maxW, maxH = unscale(maxW, screen), unscale(maxH, screen)
	case "linux":
		minW, minH = 700, 700
	}
	area := Area{Width: screen.WorkArea.Width, Height: screen.WorkArea.Height}
	var x, y int
	if runtime.GOOS == "linux" {
		x, y = Center(area, w, h)
	} else {
		x, y = Cascade(area, w, h, m.openCount())
	}
	opts.Width, opts.Height = w, h
	opts.MinWidth, opts.MinHeight = minW, minH
	opts.MaxWidth, opts.MaxHeight = maxW, maxH
	opts.InitialPosition = application.WindowXY
	opts.X, opts.Y = x, y
	opts.Mac.TitleBar = overlayTitleBar
	m.showWhenReady(m.app.Window.NewWithOptions(opts), nil)
}

func (m *Manager) openFull(opts application.WebviewWindowOptions, screen *application.Screen) {
	opts.Width, opts.Height = screen.WorkArea.Width, screen.WorkArea.Height
	opts.InitialPosition = application.WindowCentered
	opts.Mac.TitleBar = overlayTitleBar
	m.showWhenReady(m.app.Window.NewWithOptions(opts), nil)
}

func (m *Manager) openSmall(opts application.WebviewWindowOptions, screen *application.Screen) {
	opts.Width, opts.Height = 800, 500
	if runtime.GOOS == "windows" {
		// Its page is also 800×500 physical pixels (see openStandard).
		opts.Width, opts.Height = unscale(opts.Width, screen), unscale(opts.Height, screen)
	}
	opts.Frameless = true
	opts.DisableResize = true
	opts.CloseButtonState = application.ButtonDisabled
	opts.MinimiseButtonState = application.ButtonHidden
	opts.MaximiseButtonState = application.ButtonHidden
	opts.InitialPosition = application.WindowCentered
	opts.Mac.DisableShadow = true
	if runtime.GOOS == "darwin" {
		// Transparent WebKitGTK windows can fail to render with Wayland DMA-BUF, so the window is
		// opaque on Linux. It is opaque on Windows too.
		opts.BackgroundType = application.BackgroundTypeTransparent
	}
	win := m.app.Window.NewWithOptions(opts)
	m.showWhenReady(win, func() {
		// On Windows, a window put on top covers every ordinary window, the app's own dialogs and
		// prompts included. One that opened before this window, such as the config password's
		// prompt, keeps it an ordinary window.
		if runtime.GOOS == "windows" && interaction.Open() {
			return
		}
		win.SetAlwaysOnTop(true)
	})
}

// base returns the options that every window shares. The window's title is the one its page has,
// in the app's language (Title), so the title bar is right before the page has loaded.
func (m *Manager) base(name, url string) application.WebviewWindowOptions {
	m.themeMu.Lock()
	theme := m.theme
	m.themeMu.Unlock()
	return application.WebviewWindowOptions{
		Name:                       name,
		Title:                      Title(name),
		URL:                        url,
		Hidden:                     true,
		Zoom:                       1,
		ZoomControlEnabled:         false,
		DevToolsEnabled:            !m.production,
		DefaultContextMenuDisabled: m.production,
		// Never use SystemDefault. With it, Wails reapplies the system's theme to the title bar
		// every time the system's theme changes, replacing the theme that the app's settings
		// force. New handles the system's changes for the windows that follow it.
		Windows: application.WindowsWindow{Theme: windowsTheme(theme)},
	}
}

// overlayTitleBar puts the traffic lights over the content, without the window's title. The
// pages leave room for the traffic lights. Each window keeps its title for the Window menu and
// Mission Control. It only applies on macOS: Windows and Linux show the title in their title bar.
var overlayTitleBar = application.MacTitleBar{
	AppearsTransparent: true,
	FullSizeContent:    true,
	HideTitle:          true,
}

// showWhenReady shows a window that was created hidden once its page has loaded the Wails
// runtime, so it never flashes white. After 2 seconds it is shown anyway.
func (m *Manager) showWhenReady(w *application.WebviewWindow, after func()) {
	m.hookClose(w)
	var once sync.Once
	show := func() {
		once.Do(func() {
			if m.closing.Load() {
				return
			}
			w.Show()
			w.Focus()
			if after != nil {
				after()
			}
		})
	}
	w.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { show() })
	time.AfterFunc(2*time.Second, show)
}

// GuardClose sets whether closing the named window asks its page first. A page guards its window
// while it holds unsaved changes. A guarded window doesn't close: it gets EventCloseAsked, and its
// page asks the user, then stops the guard and closes the window itself. A quit closes every
// window without asking, because the quit flow asks about what is running.
func (m *Manager) GuardClose(name string, on bool) {
	m.guardMu.Lock()
	defer m.guardMu.Unlock()
	if on {
		m.guarded[name] = true
	} else {
		delete(m.guarded, name)
	}
}

func (m *Manager) isGuarded(name string) bool {
	m.guardMu.Lock()
	defer m.guardMu.Unlock()
	return m.guarded[name]
}

// hookClose stops the close of a guarded window and tells its page (see GuardClose). A page that
// loads again starts unguarded, so a reload can never leave a window that won't close.
func (m *Manager) hookClose(w *application.WebviewWindow) {
	name := w.Name()
	m.GuardClose(name, false)
	w.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if m.closing.Load() || !m.isGuarded(name) {
			return
		}
		e.Cancel()
		w.DispatchWailsEvent(&application.CustomEvent{Name: EventCloseAsked})
	})
	w.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		m.GuardClose(name, false)
	})
}

// SetTheme sets a window's appearance: "dark", "light", or "" to follow the system. Wails only
// sets the theme when a window is created, so this also sets it on an open window (see setTheme,
// which has one version per OS). Windows opened later start with this theme.
func (m *Manager) SetTheme(w application.Window, theme string) {
	m.themeMu.Lock()
	m.themes[w.Name()], m.theme = theme, theme
	m.themeMu.Unlock()
	native := w.NativeWindow()
	if native == nil {
		return
	}
	application.InvokeSync(func() { setTheme(native, theme) })
}

// reapplyThemes sets each window's theme again after the system's theme changed, so that a window
// that follows the system picks up the new theme. Only Windows needs this.
func (m *Manager) reapplyThemes() {
	for _, w := range m.app.Window.GetAll() {
		native := w.NativeWindow()
		if native == nil {
			continue
		}
		m.themeMu.Lock()
		theme, ok := m.themes[w.Name()]
		if !ok {
			theme = m.theme
		}
		m.themeMu.Unlock()
		application.InvokeAsync(func() { setTheme(native, theme) })
	}
}

func unscale(v int, s *application.Screen) int {
	if s.ScaleFactor <= 1 {
		return v
	}
	return int(float32(v) / s.ScaleFactor)
}
