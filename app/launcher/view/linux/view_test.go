package linux

import (
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

type fakeWindow struct {
	shown  bool
	height int
	sent   []sent
}

type sent struct {
	name string
	data any
}

func (w *fakeWindow) Show()                   { w.shown = true }
func (w *fakeWindow) Hide()                   { w.shown = false }
func (w *fakeWindow) SetSize(_, height int)   { w.height = height }
func (w *fakeWindow) Send(name string, d any) { w.sent = append(w.sent, sent{name, d}) }

func (w *fakeWindow) last(name string) (any, bool) {
	for i := len(w.sent) - 1; i >= 0; i-- {
		if w.sent[i].name == name {
			return w.sent[i].data, true
		}
	}
	return nil, false
}

type fakePlatform struct {
	mode      Mode
	held      bool
	presented int
	moved     *view.Placement
}

func (p *fakePlatform) Mode() Mode                         { return p.mode }
func (p *fakePlatform) BeforeShow(*view.Placement, string) {}
func (p *fakePlatform) AfterShow()                         { p.presented++ }
func (p *fakePlatform) Resized(bool)                       {}
func (p *fakePlatform) Focused()                           {}
func (p *fakePlatform) Held() bool                         { return p.held }
func (p *fakePlatform) DragStart(float64, float64)         {}
func (p *fakePlatform) DragTo(float64, float64)            {}
func (p *fakePlatform) DragEnd() (view.Placement, bool)    { return view.Placement{}, false }
func (p *fakePlatform) Moved() (view.Placement, bool) {
	if p.moved == nil {
		return view.Placement{}, false
	}
	return *p.moved, true
}

// timers holds the functions that the view runs after a delay, for the test to run when it likes.
type timers struct{ due []func() }

func (t *timers) after(_ time.Duration, fn func()) { t.due = append(t.due, fn) }

// run runs the functions that are due, and those that they schedule, n rounds at most.
func (t *timers) run(n int) {
	for range n {
		due := t.due
		t.due = nil
		for _, fn := range due {
			fn()
		}
	}
}

func newTestView(ev view.Events) (*View, *fakeWindow, *fakePlatform, *timers) {
	w, p, t := &fakeWindow{}, &fakePlatform{mode: ModeX11}, &timers{}
	return New(w, p, ev, func(fn func()) { fn() }, t.after), w, p, t
}

// Render sends the page the snapshot with its layout, and sizes the window to fit it. The footer
// animates only while the window is shown, and only for the changes that view.Swaps names.
func TestRender(t *testing.T) {
	v, w, _, _ := newTestView(view.Events{})
	s := view.Snapshot{Rows: []view.Row{{Title: "Copy"}, {Group: "App", Title: "Settings"}}, Selected: 0}
	v.Render(s)
	f, _ := w.last(EventRender)
	frame := f.(Frame)
	if frame.Swap {
		t.Error("a hidden window's footer animates")
	}
	if want := []float64{view.QueryH, view.QueryH + view.RowH + view.GroupH}; frame.Layout.RowTops[0] != want[0] || frame.Layout.RowTops[1] != want[1] {
		t.Errorf("row tops %v, want %v", frame.Layout.RowTops, want)
	}
	if w.height != int(view.Height(s)) {
		t.Errorf("height %d, want %v", w.height, view.Height(s))
	}

	v.Show(nil)
	s.Status = view.Status{Kind: view.StatusLoading, Text: "Listing…"}
	v.Render(s)
	f, _ = w.last(EventRender)
	if !f.(Frame).Swap {
		t.Error("a status doesn't animate in")
	}
	if got := v.Ready().Frame.Line.Status.Text; got != "Listing…" {
		t.Errorf("Ready's footer %q", got)
	}
}

// A text that the launcher sets carries the number of the page's last edit that it had seen.
func TestQueryNumbers(t *testing.T) {
	var got string
	v, w, _, _ := newTestView(view.Events{Query: func(text string) { got = text }})
	v.Query("co", 7)
	if got != "co" {
		t.Fatalf("the launcher got %q", got)
	}
	v.SetQuery("copy", true)
	q, _ := w.last(EventQuery)
	if want := (Query{Text: "copy", SelectAll: true, Seq: 7}); q.(Query) != want {
		t.Errorf("query %+v, want %+v", q, want)
	}
	if v.Ready().Query.Seq != 7 {
		t.Error("Ready doesn't have the last edit's number")
	}
}

// The page's keys reach the launcher only while it is shown. A row key needs its one character.
func TestKeys(t *testing.T) {
	var keys []view.KeyEvent
	v, _, _, _ := newTestView(view.Events{Key: func(k view.KeyEvent) bool { keys = append(keys, k); return true }})
	v.Key("down", "")
	if len(keys) != 0 {
		t.Fatal("a hidden launcher got a key")
	}
	v.Show(nil)
	v.Key("down", "")
	v.Key("row", "b")
	v.Key("row", "")      // no character
	v.Key("unknown", "x") // not a key the page sends
	v.Closed()
	want := []view.KeyEvent{{Key: view.KeyDown}, {Key: view.KeyRow, Char: 'b'}, {Key: view.KeyClose}}
	if len(keys) != len(want) {
		t.Fatalf("keys %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Errorf("key %d is %v, want %v", i, keys[i], want[i])
		}
	}
}

// Blur waits while files are dragged over the window or a button is down, then for the grace
// period, and a regained focus cancels it.
func TestBlurWait(t *testing.T) {
	blurred := 0
	v, _, p, timers := newTestView(view.Events{Blur: func() { blurred++ }})
	v.Show(nil)

	v.FocusLost()
	v.DragOver(true)
	timers.run(3)
	if blurred != 0 {
		t.Fatal("blurred while files were dragged over the window")
	}
	v.DragOver(false)
	p.held = true
	timers.run(3)
	if blurred != 0 {
		t.Fatal("blurred while a button was down")
	}
	p.held = false
	v.blurFrom = time.Now().Add(-blurGrace) // the grace period is over
	timers.run(1)
	if blurred != 1 {
		t.Fatalf("blurred %d times, want 1", blurred)
	}

	v.FocusLost()
	v.Focused()
	v.blurFrom = time.Now().Add(-blurGrace)
	timers.run(3)
	if blurred != 1 {
		t.Error("a regained focus didn't cancel the Blur")
	}
}

// Dropped files take the keyboard back and go to the launcher, but not while it is hidden.
func TestDropped(t *testing.T) {
	var dropped []string
	v, _, p, _ := newTestView(view.Events{Drop: func(paths []string) { dropped = paths }})
	v.Dropped([]string{"/tmp/a"})
	if dropped != nil {
		t.Fatal("a hidden launcher took a drop")
	}
	v.Show(nil)
	before := p.presented
	v.Dropped([]string{"/tmp/a"})
	if len(dropped) != 1 || p.presented != before+1 {
		t.Errorf("dropped %v, presented %d times", dropped, p.presented-before)
	}
}

// A move that the platform reports goes to the launcher. One that the view made itself doesn't.
func TestMoved(t *testing.T) {
	var at *view.Placement
	v, _, p, _ := newTestView(view.Events{Moved: func(pl view.Placement) { at = &pl }})
	v.Show(nil)
	v.Moved()
	if at != nil {
		t.Fatal("the view's own move was reported")
	}
	p.moved = &view.Placement{Left: 40, Top: 50}
	v.Moved()
	if at == nil || *at != *p.moved {
		t.Errorf("moved to %v, want %v", at, p.moved)
	}
}

// A panic in a callback from the page goes to Panicked rather than up through the service call.
func TestPanicked(t *testing.T) {
	var where string
	v, _, _, _ := newTestView(view.Events{
		Query:    func(string) { panic("boom") },
		Panicked: func(w string, _ any) { where = w },
	})
	v.Query("x", 1)
	if where != "launcher page query" {
		t.Errorf("Panicked got %q", where)
	}
}

// A layer surface's margins follow the pointer, but never past the monitor's top or left edge.
func TestDragMargins(t *testing.T) {
	if l, tp := dragMargins(100, 50, 12.4, -8.6); l != 112 || tp != 41 {
		t.Errorf("got %d, %d", l, tp)
	}
	if l, tp := dragMargins(5, 5, -20, -20); l != 0 || tp != 0 {
		t.Errorf("got %d, %d past the edges", l, tp)
	}
	if got := topMargin(1080); got != int((1080-view.FullHeight())/2) {
		t.Errorf("top margin %d", got)
	}
}
