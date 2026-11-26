package linux

import (
	"math"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/view"
)

const Title = "Rclone UI Launcher"

const (
	EventRender = "launcher:render"
	EventQuery  = "launcher:query"
	EventShown  = "launcher:shown"
	EventHidden = "launcher:hidden"
)

type Mode string

const (
	ModeX11     Mode = "x11"
	ModeLayer   Mode = "layer-shell"
	ModeWayland Mode = "wayland"
)

type Window interface {
	Show()
	Hide()
	SetSize(width, height int)
	Send(name string, data any)
}

type Platform interface {
	Mode() Mode
	BeforeShow(at *view.Placement, token string)
	AfterShow()
	Resized(visible bool)
	Focused()
	Held() bool
	Moved() (view.Placement, bool)
	// DragStart, DragTo and DragEnd move a layer surface, because compositors don't move those.
	// The points are the pointer's, measured from the window's top-left corner. DragEnd reports
	// where the surface was left.
	DragStart(x, y float64)
	DragTo(x, y float64)
	DragEnd() (view.Placement, bool)
}

type Layout struct {
	Height    float64   `json:"height"`
	RowsTop   float64   `json:"rowsTop"`
	ListH     float64   `json:"listH"`
	RowTops   []float64 `json:"rowTops"`
	FooterTop float64   `json:"footerTop"`
	StopTop   float64   `json:"stopTop"`
}

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

const (
	blurPoll  = 50 * time.Millisecond
	blurGrace = 250 * time.Millisecond
)

type View struct {
	win   Window
	plat  Platform
	ev    view.Events
	main  func(func())
	after func(time.Duration, func())

	mu    sync.Mutex
	state Init

	visible bool
	token   string
	line    view.Line
	seq     int

	blurGen  int
	blurFrom time.Time
	dragOver bool
	pressed  bool
	dragging bool
}

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

func (v *View) PlacedByShell() bool { return v.plat.Mode() == ModeWayland }

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

var pageKeys = map[string]view.Key{
	"up":      view.KeyUp,
	"down":    view.KeyDown,
	"enter":   view.KeyEnter,
	"esc":     view.KeyEsc,
	"tab":     view.KeyTab,
	"actions": view.KeyActions,
	"row":     view.KeyRow,
}

func (v *View) Query(text string, seq int) {
	v.call("query", func() {
		v.seq = seq
		if v.ev.Query != nil {
			v.ev.Query(text)
		}
	})
}

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

func (v *View) Pressed(down bool) {
	v.call("pressed", func() {
		v.pressed = down
		if !down {
			v.blurFrom = time.Now()
		}
	})
}

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
	v.blurGen++
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
