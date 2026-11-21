// Package linux is the launcher window on Linux. It is a window of the app like the others, whose
// page (src/pages/Launcher) draws the launcher's Snapshot. The launcher is native on macOS and
// Windows. On Linux a page lets the app use GTK 4, which is what Wails uses there.
//
// The view sends the page what to draw as events to that window alone (Render, SetQuery, Show and
// Hide). The page reports what the user does through PageService (service.go), and the view
// passes it on to the launcher on the main thread.
//
// Wayland doesn't let an ordinary window choose where it goes, whether it stays above other
// windows, or when it takes focus. When the compositor supports layer-shell (KDE Plasma, COSMIC,
// Hyprland, Sway and the other wlroots compositors), the window is a layer surface, like other
// launchers there. GNOME doesn't support layer-shell, so there the window is an ordinary one, and
// the launcher's GNOME Shell extension (in gnome/) places and focuses it. On X11 the view places
// the window itself and keeps it above the others (see platform_linux.go).
package linux

import (
	"math"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/view"
)

// Title is the window's title. The GNOME extension (gnome/extension.js) uses it to recognise the
// launcher window.
const Title = "Rclone UI Launcher"

const (
	EventRender = "launcher:render" // a Frame
	EventQuery  = "launcher:query"  // a Query
	EventShown  = "launcher:shown"  // the window was shown: focus the query box
	EventHidden = "launcher:hidden" // the window was hidden: finish any animation
)

type Mode string

const (
	ModeX11     Mode = "x11"         // an X11 window, which the view places
	ModeLayer   Mode = "layer-shell" // a Wayland layer surface
	ModeWayland Mode = "wayland"     // an ordinary Wayland window, which the desktop shell places
)

type Window interface {
	Show()
	Hide()
	SetSize(width, height int)
	// Send sends an event to this window's page alone.
	Send(name string, data any)
}

// Platform places the window and gives it the keyboard. Every method runs on the main thread.
type Platform interface {
	Mode() Mode
	// BeforeShow places the hidden window at at, if that spot is still on a screen, or else
	// centres it on the screen in use. token is the Wayland activation token, "" for none.
	BeforeShow(at *view.Placement, token string)
	// AfterShow runs once the window is shown, and asks for the keyboard.
	AfterShow()
	// Resized runs after the window's height changes. A shown X11 window keeps its top edge.
	Resized(visible bool)
	Focused()
	// Held reports whether a pointer button is down anywhere on the screen. Only X11 can tell.
	Held() bool
	// Moved reports where the user moved the window, after the window reported a move. It is
	// false when the view moved it itself, or when the desktop doesn't say where windows are.
	Moved() (view.Placement, bool)
	// DragStart, DragTo and DragEnd move a layer surface, because compositors don't move those.
	// The points are the pointer's, measured from the window's top-left corner. DragEnd reports
	// where the surface was left.
	DragStart(x, y float64)
	DragTo(x, y float64)
	DragEnd() (view.Placement, bool)
}

// Layout is where the page puts things for one Snapshot, measured from the window's top-left
// corner. The view works it out from the launcher's geometry (view/geometry.go), so the page
// draws exactly what the window's size allows.
type Layout struct {
	Height    float64   `json:"height"`
	RowsTop   float64   `json:"rowsTop"`
	ListH     float64   `json:"listH"`
	RowTops   []float64 `json:"rowTops"`
	FooterTop float64   `json:"footerTop"`
	StopTop   float64   `json:"stopTop"`
}

// Frame is what the page draws. Swap reports that the footer line animates in from the one before
// (view.Swaps).
type Frame struct {
	Snapshot view.Snapshot `json:"snapshot"`
	Layout   Layout        `json:"layout"`
	Line     view.Line     `json:"line"`
	Swap     bool          `json:"swap"`
}

// Query is a text that the launcher sets in the query box. Seq is the number of the page's last
// edit that the launcher had seen when it set the text (see View.Query). A page that has been
// typed in since keeps its own text, because the launcher's is out of date.
type Query struct {
	Text      string `json:"text"`
	SelectAll bool   `json:"selectAll"`
	Seq       int    `json:"seq"`
}

// Geometry holds the launcher's sizes, in pixels, for the page.
type Geometry struct {
	Width      float64 `json:"width"`
	QueryH     float64 `json:"queryH"`
	HeaderH    float64 `json:"headerH"`
	RowH       float64 `json:"rowH"`
	GroupH     float64 `json:"groupH"`
	FooterH    float64 `json:"footerH"`
	Padding    float64 `json:"padding"`
	IconSize   float64 `json:"iconSize"`
	FieldTop   float64 `json:"fieldTop"`
	FieldW     float64 `json:"fieldW"`
	StopSize   float64 `json:"stopSize"`
	StopLeft   float64 `json:"stopLeft"`
	FooterW    float64 `json:"footerW"`
	SpinSize   float64 `json:"spinSize"`
	StatusLeft float64 `json:"statusLeft"`
	Slide      float64 `json:"slide"`
	SwapMs     int     `json:"swapMs"`
}

// Init is what the page needs when it loads. It includes what the view last sent, so a page that
// loads after the launcher rendered still draws the same.
type Init struct {
	Geometry Geometry `json:"geometry"`
	// Icons holds each glyph's SVG document by name, drawn in currentColor so the page can tint it.
	Icons map[string]string `json:"icons"`
	// Mode tells the page who drags the window: the page drags a layer surface (DragStart), and
	// the window manager drags any other window.
	Mode Mode `json:"mode"`
	// RowLetters are the letters that run rows with Ctrl (view.RowLetters), after the digits.
	// The page leaves Ctrl with any other letter to the query box.
	RowLetters string `json:"rowLetters"`
	Frame      Frame  `json:"frame"`
	Query      Query  `json:"query"`
	Visible    bool   `json:"visible"`
}

var geometry = Geometry{
	Width: view.Width, QueryH: view.QueryH, HeaderH: view.HeaderH, RowH: view.RowH,
	GroupH: view.GroupH, FooterH: view.FooterH, Padding: view.Padding, IconSize: view.IconSize,
	FieldTop: view.FieldTop, FieldW: view.FieldW, StopSize: view.StopSize, StopLeft: view.StopLeft,
	FooterW: view.FooterW, SpinSize: view.SpinSize, StatusLeft: view.StatusLeft, Slide: view.Slide,
	SwapMs: int(view.SwapFor.Milliseconds()),
}

var glyphs = sync.OnceValue(func() map[string]string {
	out := map[string]string{}
	for _, n := range icons.All() {
		out[string(n)] = icons.Tinted(n, "currentColor")
	}
	return out
})

func layoutOf(s view.Snapshot) Layout {
	tops := make([]float64, len(s.Rows))
	for i := range s.Rows {
		tops[i] = view.RowTop(s, i)
	}
	return Layout{
		Height:    view.Height(s),
		RowsTop:   view.RowsTop(s.Header != ""),
		ListH:     view.ListH(s),
		RowTops:   tops,
		FooterTop: view.FooterTop(s),
		StopTop:   view.StopTop(s),
	}
}

// Timing for the Blur wait (see FocusLost).
const (
	blurPoll  = 50 * time.Millisecond  // how often it checks
	blurGrace = 250 * time.Millisecond // how long it waits after a button is released or a drag leaves
)

// View is the launcher window. Its view.View methods run on the main thread. The page's methods
// (Ready, Query, Key and the rest) may be called from any goroutine.
type View struct {
	win   Window
	plat  Platform
	ev    view.Events
	main  func(func())
	after func(time.Duration, func())

	mu    sync.Mutex // guards state, which Ready reads from a service call
	state Init

	visible bool
	token   string
	line    view.Line // the footer line that the page shows
	seq     int       // the number of the page's last edit (see Query)

	// The Blur wait. blurGen counts the waits, so a stopped wait's pending check does nothing.
	blurGen  int
	blurFrom time.Time
	dragOver bool // files are dragged over the window, as the page reports
	pressed  bool // a pointer button is down in the window, as the page reports
	dragging bool // a layer surface is being dragged
}

// New returns the view of win, which plat places. main runs a function on the main thread, and
// after runs one there after a delay.
func New(win Window, plat Platform, ev view.Events, main func(func()), after func(time.Duration, func())) *View {
	return &View{
		win: win, plat: plat, ev: ev, main: main, after: after,
		state: Init{
			Geometry: geometry, Mode: plat.Mode(), RowLetters: view.RowLetters,
			Frame: Frame{Snapshot: view.Snapshot{Selected: -1}},
		},
	}
}

func (v *View) Mode() string { return string(v.plat.Mode()) }

// PlacedByShell reports whether the window is an ordinary Wayland window, which only the desktop
// shell can place, keep above other windows and focus. On GNOME, the launcher's extension (in
// gnome/) does this.
func (v *View) PlacedByShell() bool { return v.plat.Mode() == ModeWayland }

// SetActivationToken sets the compositor's token for the shortcut press (the portal's
// activation_token). On Wayland, the next Show uses it to take the keyboard.
func (v *View) SetActivationToken(token string) { v.token = token }

func (v *View) Show(at *view.Placement) {
	v.visible = true
	v.setVisible(true)
	v.plat.BeforeShow(at, v.token)
	v.token = ""
	v.win.Show()
	v.plat.AfterShow()
	v.win.Send(EventShown, nil)
}

func (v *View) Hide() {
	v.visible = false
	v.setVisible(false)
	v.dragging, v.dragOver, v.pressed = false, false, false
	v.stopBlur()
	v.win.Hide()
	v.win.Send(EventHidden, nil)
}

func (v *View) Visible() bool { return v.visible }

func (v *View) Render(s view.Snapshot) {
	line := view.FooterLine(s)
	f := Frame{Snapshot: s, Layout: layoutOf(s), Line: line, Swap: v.visible && view.Swaps(v.line, line)}
	v.line = line
	v.mu.Lock()
	v.state.Frame = f
	v.mu.Unlock()
	v.win.Send(EventRender, f)
	v.win.SetSize(int(view.Width), int(math.Ceil(f.Layout.Height)))
	v.plat.Resized(v.visible)
}

func (v *View) SetQuery(text string, selectAll bool) {
	q := Query{Text: text, SelectAll: selectAll, Seq: v.seq}
	v.mu.Lock()
	v.state.Query = q
	v.mu.Unlock()
	v.win.Send(EventQuery, q)
}

func (v *View) setVisible(on bool) {
	v.mu.Lock()
	v.state.Visible = on
	v.mu.Unlock()
}

func (v *View) Ready() Init {
	v.mu.Lock()
	defer v.mu.Unlock()
	in := v.state
	in.Icons = glyphs()
	return in
}

// The page's keys, as the page names them (src/pages/Launcher/keys.ts).
var pageKeys = map[string]view.Key{
	"up":      view.KeyUp,
	"down":    view.KeyDown,
	"enter":   view.KeyEnter,
	"esc":     view.KeyEsc,
	"tab":     view.KeyTab,
	"actions": view.KeyActions,
	"row":     view.KeyRow,
}

// Query receives the query box's text after an edit. The page numbers its edits, and seq is this
// one's number. SetQuery sends the number back with the text that the launcher sets, so the page
// can tell when it has been typed in since (see the Query type).
func (v *View) Query(text string, seq int) {
	v.call("query", func() {
		v.seq = seq
		if v.ev.Query != nil {
			v.ev.Query(text)
		}
	})
}

// Key receives a key that the page leaves to the launcher. char is the character of a "row" key:
// a digit, a letter or a full stop pressed with Ctrl.
func (v *View) Key(key, char string) {
	k, ok := pageKeys[key]
	if !ok {
		return
	}
	e := view.KeyEvent{Key: k}
	if k == view.KeyRow {
		r := []rune(char)
		if len(r) != 1 {
			return
		}
		e.Char = r[0]
	}
	v.call("key", func() {
		if v.visible && v.ev.Key != nil {
			v.ev.Key(e)
		}
	})
}

func (v *View) Hover(row int) {
	v.call("hover", func() {
		if v.visible && v.ev.Hover != nil {
			v.ev.Hover(row)
		}
	})
}

func (v *View) Click(row int) {
	v.call("click", func() {
		if v.visible && v.ev.Click != nil {
			v.ev.Click(row)
		}
	})
}

func (v *View) Scroll(rows int) {
	v.call("scroll", func() {
		if v.visible && rows != 0 && v.ev.Scroll != nil {
			v.ev.Scroll(rows)
		}
	})
}

func (v *View) StopAll() {
	v.call("stop all", func() {
		if v.ev.StopAll != nil {
			v.ev.StopAll()
		}
	})
}

// Pressed receives whether a pointer button is down in the window. The Blur wait waits while it
// is, because a drag may be starting.
func (v *View) Pressed(down bool) {
	v.call("pressed", func() {
		v.pressed = down
		if !down {
			v.blurFrom = time.Now()
		}
	})
}

// DragOver receives whether files are being dragged over the window. The Blur wait waits while
// they are, so they can still be dropped.
func (v *View) DragOver(over bool) {
	v.call("drag over", func() {
		v.dragOver = over
		if !over {
			v.blurFrom = time.Now()
		}
	})
}

func (v *View) DragStart(x, y float64) {
	v.call("drag start", func() {
		if v.visible && v.plat.Mode() == ModeLayer {
			v.dragging = true
			v.plat.DragStart(x, y)
		}
	})
}

func (v *View) DragMove(x, y float64) {
	v.call("drag move", func() {
		if v.dragging {
			v.plat.DragTo(x, y)
		}
	})
}

func (v *View) DragEnd() {
	v.call("drag end", func() {
		if !v.dragging {
			return
		}
		v.dragging = false
		if at, ok := v.plat.DragEnd(); ok && v.ev.Moved != nil {
			v.ev.Moved(at)
		}
	})
}

func (v *View) Focused() {
	v.call("focus", func() {
		v.stopBlur()
		if v.visible {
			v.plat.Focused()
		}
	})
}

// FocusLost reports that the window lost the keyboard (Blur), but only once it is clear that the
// user has left the window. It waits while a pointer button is down, because a drag may be
// starting in another window to drop files here. It also waits while files are dragged over the
// window, and for blurGrace after either ends. X11 reports a button pressed anywhere, but Wayland
// only one pressed on this window, so on Wayland the grace period gives a drag from elsewhere time
// to arrive.
func (v *View) FocusLost() {
	v.call("focus lost", func() {
		if !v.visible || v.ev.Blur == nil {
			return
		}
		v.blurFrom = time.Now()
		v.blurGen++
		v.waitBlur(v.blurGen)
	})
}

func (v *View) waitBlur(gen int) {
	v.after(blurPoll, func() { v.call("blur", func() { v.blurCheck(gen) }) })
}

func (v *View) blurCheck(gen int) {
	if gen != v.blurGen || !v.visible {
		return
	}
	if v.dragOver || v.pressed || v.plat.Held() {
		v.blurFrom = time.Now()
		v.waitBlur(gen)
		return
	}
	if time.Since(v.blurFrom) < blurGrace {
		v.waitBlur(gen)
		return
	}
	v.blurGen++ // the wait is over; Blur may call Hide
	if v.ev.Blur != nil {
		v.ev.Blur()
	}
}

func (v *View) stopBlur() { v.blurGen++ }

func (v *View) Moved() {
	v.call("moved", func() {
		if !v.visible {
			return
		}
		if at, ok := v.plat.Moved(); ok && v.ev.Moved != nil {
			v.ev.Moved(at)
		}
	})
}

// Dropped takes the keyboard back before it passes the files on.
func (v *View) Dropped(paths []string) {
	v.call("dropped", func() {
		v.dragOver = false
		if !v.visible || len(paths) == 0 || v.ev.Drop == nil {
			return
		}
		v.plat.AfterShow()
		v.win.Send(EventShown, nil)
		v.ev.Drop(paths)
	})
}

// Closed handles a request to close the window, such as Alt+F4. The window is only ever hidden,
// so the launcher dismisses itself instead.
func (v *View) Closed() {
	v.call("close", func() {
		if v.ev.Key != nil {
			v.ev.Key(view.KeyEvent{Key: view.KeyClose})
		}
	})
}

func (v *View) call(name string, body func()) {
	v.main(func() {
		defer func() {
			if p := recover(); p != nil {
				if v.ev.Panicked != nil {
					v.ev.Panicked("launcher page "+name, p)
					return
				}
				panic(p)
			}
		}()
		body()
	})
}
