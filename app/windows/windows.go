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
	"github.com/rclone/rclone-ui/app/platform"
)

const (
	// EventCloseAsked tells a window that the user asked to close it while its page guards the
	// close (see GuardClose). The page asks the user, and closes the window itself.
	EventCloseAsked = "window:close"
	// EventRoute tells an open window to switch to a route, which is the event's data.
	EventRoute = "window:route"
)

const (
	DefaultWidth  = 840
	DefaultHeight = 725
)

type Manager struct {
	app        *application.App
	log        *slog.Logger
	production bool
	mu         sync.Mutex
	Opened     func(name string)
	closing    atomic.Bool

	themeMu sync.Mutex
	themes  map[string]string
	theme   string

	guardMu sync.Mutex
	guarded map[string]bool
}

func New(app *application.App, log *slog.Logger, production bool) *Manager {
	m := &Manager{app: app, log: log, production: production, themes: map[string]string{}, guarded: map[string]bool{}}
	if runtime.GOOS == "windows" {
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

type dispatcher interface {
	DispatchWailsEvent(event *application.CustomEvent)
}

// Wails' Emit would send the event to every window.
func route(w dispatcher, url string) {
	w.DispatchWailsEvent(&application.CustomEvent{Name: EventRoute, Data: url})
}

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
	if _, own := titleOf(name); own && m.Opened != nil {
		m.Opened(name)
	}
	return nil
}

func (m *Manager) openStandard(opts application.WebviewWindowOptions, screen *application.Screen) {
	w, h := DefaultWidth, DefaultHeight
	minW, minH := 650, 500
	maxW, maxH := 1000, 1000
	if runtime.GOOS == "linux" {
		minW, minH = 700, 700
	}
	ts := platform.TextScale()
	w, h = grow(w, ts), grow(h, ts)
	minW, minH = grow(minW, ts), grow(minH, ts)
	maxW, maxH = grow(maxW, ts), grow(maxH, ts)
	area := Area{Width: screen.WorkArea.Width, Height: screen.WorkArea.Height}
	w, h = min(w, area.Width), min(h, area.Height)
	minW, minH = min(minW, w), min(minH, h)
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
	m.showWhenReady(m.app.Window.NewWithOptions(opts), opts, nil)
}

func (m *Manager) openFull(opts application.WebviewWindowOptions, screen *application.Screen) {
	opts.Width, opts.Height = screen.WorkArea.Width, screen.WorkArea.Height
	opts.InitialPosition = application.WindowCentered
	opts.Mac.TitleBar = overlayTitleBar
	m.showWhenReady(m.app.Window.NewWithOptions(opts), opts, nil)
}

func (m *Manager) openSmall(opts application.WebviewWindowOptions, screen *application.Screen) {
	opts.Width, opts.Height, opts.Zoom = fit(800, 500, platform.TextScale(), Area{Width: screen.WorkArea.Width, Height: screen.WorkArea.Height})
	opts.Frameless = true
	opts.DisableResize = true
	opts.CloseButtonState = application.ButtonDisabled
	opts.MinimiseButtonState = application.ButtonHidden
	opts.MaximiseButtonState = application.ButtonHidden
	opts.InitialPosition = application.WindowCentered
	// Esc closes the window. The binding is native, so it works even when the page failed to load
	// (#262). Without it, that window has no way to close: it has no close button and stays on top.
	opts.KeyBindings = map[string]func(application.Window){
		"escape": func(w application.Window) { w.Close() },
	}
	opts.Mac.DisableShadow = true
	if runtime.GOOS == "darwin" {
		// Transparent WebKitGTK windows can fail to render with Wayland DMA-BUF.
		opts.BackgroundType = application.BackgroundTypeTransparent
	}
	win := m.app.Window.NewWithOptions(opts)
	m.showWhenReady(win, opts, func() {
		// On Windows, a window put on top covers every ordinary window, the app's own dialogs and
		// prompts included.
		if runtime.GOOS == "windows" && interaction.Open() {
			return
		}
		win.SetAlwaysOnTop(true)
	})
}

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
		// With SystemDefault, Wails reapplies the system's theme to the title bar every time the
		// system's theme changes, replacing the theme that the app's settings force.
		Windows: application.WindowsWindow{Theme: windowsTheme(theme)},
	}
}

var overlayTitleBar = application.MacTitleBar{
	AppearsTransparent: true,
	FullSizeContent:    true,
	HideTitle:          true,
}

func (m *Manager) showWhenReady(w *application.WebviewWindow, opts application.WebviewWindowOptions, after func()) {
	m.hookClose(w)
	var once sync.Once
	show := func() {
		once.Do(func() {
			if m.closing.Load() {
				return
			}
			w.Show()
			if runtime.GOOS == "linux" {
				placeAgain(w, opts)
			}
			w.Focus()
			if after != nil {
				after()
			}
		})
	}
	w.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { show() })
	time.AfterFunc(2*time.Second, show)
}

// On Linux, Wails places a hidden window before GTK gives it a surface, so the move does nothing,
// and the window manager chooses the position. Wails places a window that it creates visible a
// second time after it is shown, in the same way. On Wayland, the compositor always chooses.
func placeAgain(w *application.WebviewWindow, opts application.WebviewWindowOptions) {
	if opts.Screen == nil {
		return
	}
	width, height := w.Size()
	w.SetPosition(placement(opts.Screen.WorkArea, opts, width, height))
}

func placement(area application.Rect, opts application.WebviewWindowOptions, width, height int) (x, y int) {
	if opts.InitialPosition == application.WindowCentered {
		return area.X + (area.Width-width)/2, area.Y + (area.Height-height)/2
	}
	return area.X + opts.X, area.Y + opts.Y
}

// GuardClose sets whether closing the named window asks its page first. A page guards its window
// while it holds unsaved changes. A guarded window doesn't close: it gets EventCloseAsked, and its
// page asks the user, then stops the guard and closes the window itself.
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

// SetTheme sets a window's appearance: "dark", "light", or "" to follow the system. Windows
// opened later start with this theme. Wails only sets the theme when a window is created.
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

func grow(v int, scale float64) int { return int(float64(v)*scale + 0.5) }

func fit(w, h int, scale float64, area Area) (width, height int, zoom float64) {
	width, height, zoom = grow(w, scale), grow(h, scale), 1
	if area.Width <= 0 || area.Height <= 0 {
		return width, height, zoom
	}
	if r := min(float64(area.Width)/float64(width), float64(area.Height)/float64(height)); r < 1 {
		width, height, zoom = int(float64(width)*r), int(float64(height)*r), r
	}
	return width, height, zoom
}
