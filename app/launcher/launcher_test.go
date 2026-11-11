package launcher

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/app/launcher/view/viewtest"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/mounts"
)

// The search box's placeholders, as the launcher shows them in English.
const (
	placeholder     = "Search commands, remotes, or paste a URL"
	dropPlaceholder = "Where to? Type a remote or a folder"
)

// source is a fake core with two remotes, plus a mount when mounted is set. list lists folders.
// everything, when set, is its Stop Everything.
type source struct {
	mounted    bool
	list       func(ctx context.Context, dir string, page func([]engine.Entry)) error
	everything *stopAll
}

func (s source) Data() *engine.Data {
	d := &engine.Data{
		Remotes: []engine.Remote{
			{Name: "gdrive", Type: "drive"},
			{Name: "s3", Type: "s3"},
		},
		List: s.list,
	}
	if s.mounted {
		d.Mounts = []mounts.MountRow{{ID: "m1", Source: "gdrive:", MountPoint: "/Volumes/gdrive", State: "running"}}
	}
	return d
}
func (s source) Services() engine.Services {
	if s.everything == nil {
		return engine.Services{}
	}
	return engine.Services{Everything: s.everything}
}
func (source) RefreshIfOlder(context.Context, time.Duration) {}
func (source) FollowProgress(bool)                           {}
func (source) OnChange(func())                               {}

// stopAll is a fake Stop Everything, which counts its calls and stops a mount.
type stopAll struct{ calls atomic.Int32 }

func (s *stopAll) StopAll(context.Context) (core.StopSummary, error) {
	s.calls.Add(1)
	return core.StopSummary{Running: core.Running{Mounts: 1}}, nil
}

// harness runs a launcher on its own fake main thread, with a fake view.
type harness struct {
	t     *testing.T
	l     *Launcher
	v     *viewtest.Fake
	calls chan string
	main  chan func()
	done  chan struct{}
	// activated counts the calls to Platform.Activate
	activated atomic.Int32
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, v: &viewtest.Fake{}, calls: make(chan string, 32), main: make(chan func()), done: make(chan struct{})}
	go func() {
		for {
			select {
			case fn := <-h.main:
				fn()
			case <-h.done:
				return
			}
		}
	}()
	t.Cleanup(func() { close(h.done) })
	record := func(s string) {
		select {
		case h.calls <- s:
		default:
		}
	}
	p := Platform{
		OpenWindow: func(name, url string) { record("window " + name + " " + url) },
		OpenFull:   func(name, url string) { record("full " + name + " " + url) },
		Clipboard:  func(text string) { record("clipboard " + text) },
		Reveal:     func(path string) { record("reveal " + path) },
		OpenURL:    func(url string) { record("url " + url) },
		Notify:     func(title, body string) { record("notify " + title + ": " + body) },
		Activate:   func() { h.activated.Add(1) },
		Quit:       func() { record("quit") },
		Main: func(fn func()) {
			go func() {
				select {
				case h.main <- fn:
				case <-h.done:
				}
			}()
		},
		MainSync: func(fn func()) { done := make(chan struct{}); h.main <- func() { fn(); close(done) }; <-done },
		Mod:      "⌘",
	}
	h.l = New(p, slog.New(slog.NewTextHandler(io.Discard, nil)), source{}, nil)
	h.v.Events = h.l.Events()
	h.l.Attach(h.v)
	return h
}

// do runs fn on the launcher's main thread.
func (h *harness) do(fn func()) {
	done := make(chan struct{})
	h.main <- func() { fn(); close(done) }
	<-done
}

// settle waits until the rows drawn are for the current text, and returns their titles.
func (h *harness) settle() []string {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var ok bool
		var titles []string
		h.do(func() { ok = h.l.fresh && !h.l.busy; titles = h.v.Titles() })
		if ok {
			return titles
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("no answer for %q", h.l.text)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) typeText(s string) []string {
	h.do(func() { h.v.Type(s) })
	return h.settle()
}

func (h *harness) press(k view.Key, c rune) bool {
	var took bool
	h.do(func() { took = h.v.Press(view.KeyEvent{Key: k, Char: c}) })
	return took
}

func (h *harness) call() string {
	h.t.Helper()
	select {
	case c := <-h.calls:
		return c
	case <-time.After(2 * time.Second):
		h.t.Fatal("no call")
		return ""
	}
}

func TestShowTypeAndRun(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	rows := h.settle()
	if len(rows) == 0 || rows[0] != "Run" {
		t.Fatalf("shown: %q", rows)
	}
	if f := h.v.Last.Footer; len(f) == 0 || f[0].Label != "Open Wizard" {
		t.Errorf("footer %v", f)
	}
	rows = h.typeText("mo")
	if rows[0] != "Move" || rows[1] != "Mount" {
		t.Fatalf("mo: %q", rows)
	}
	h.press(view.KeyDown, 0)
	if h.v.Last.Selected != 1 {
		t.Errorf("down: selected %d", h.v.Last.Selected)
	}
	// a new query starts at the top
	h.typeText("mou")
	if h.v.Last.Selected != 0 {
		t.Errorf("new query: selected %d", h.v.Last.Selected)
	}
	h.typeText("copy")
	h.press(view.KeyEnter, 0)
	if c := h.call(); c != "window Copy /copy" {
		t.Errorf("enter: %q", c)
	}
	if h.v.Shown {
		t.Error("the launcher stays up after opening a window")
	}
}

func TestRowShortcuts(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	if h.v.Last.Rows[1].Hint != "⌘2" {
		t.Errorf("hint %q", h.v.Last.Rows[1].Hint)
	}
	h.press(view.KeyRow, '1')
	if c := h.call(); c != "window Wizard /wizard" {
		t.Errorf("⌘1: %q", c)
	}
	if rowIndex('k') != -1 || rowIndex('a') != -1 || rowIndex('b') != 9 {
		t.Error("row letters")
	}
	// the clipboard, actions, app and text box keys never run a row
	for _, c := range "acvxkqwhmyz" {
		if rowIndex(c) != -1 {
			t.Errorf("⌘%c runs a row", c)
		}
	}
}

func TestActionPanel(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.typeText("gdr")
	if h.v.Last.Rows[0].Title != "gdrive" {
		t.Fatalf("gdr: %q", h.v.Titles())
	}
	h.press(view.KeyActions, 0)
	if h.v.Last.Header != "Actions for gdrive" || h.v.Query != "" {
		t.Fatalf("panel: header %q, query %q", h.v.Last.Header, h.v.Query)
	}
	if !slices.Contains(h.v.Titles(), "Copy From") {
		t.Errorf("actions %q", h.v.Titles())
	}
	h.do(func() { h.v.Type("edit") })
	if got := h.v.Titles(); len(got) != 1 || got[0] != "Edit Remote" {
		t.Errorf("filtered: %q", got)
	}
	h.press(view.KeyEsc, 0)
	if h.v.Last.Header != "" || h.v.Query != "gdr" || !h.v.Shown {
		t.Errorf("esc closes the panel: header %q, query %q, shown %v", h.v.Last.Header, h.v.Query, h.v.Shown)
	}
	h.press(view.KeyActions, 0)
	h.do(func() { h.v.Type("edit") })
	h.press(view.KeyEnter, 0)
	if c := h.call(); c != "window Remotes /remotes?action=edit&remote=gdrive" {
		t.Errorf("panel action: %q", c)
	}
}

// TestScroll: the wheel scrolls the rows and keeps the selection among the rows drawn. Long lists
// in the panel scroll too.
func TestScroll(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	var all []string
	h.do(func() {
		for _, r := range h.l.results {
			all = append(all, r.Title)
		}
	})
	if len(all) <= view.MaxRows+3 {
		t.Fatalf("too few results to scroll: %q", all)
	}
	drawn := func() (string, int) {
		var first string
		var sel int
		h.do(func() { first, sel = h.v.Last.Rows[0].Title, h.v.Last.Selected })
		return first, sel
	}
	scroll := func(n int) { h.do(func() { h.v.Events.Scroll(n) }) }

	scroll(3)
	if first, sel := drawn(); first != all[3] || sel != 0 {
		t.Errorf("down 3: first %q, selected row %d", first, sel)
	}
	scroll(-1) // the selection, still on all[3], stays where it is
	if first, sel := drawn(); first != all[2] || sel != 1 {
		t.Errorf("up 1: first %q, selected row %d", first, sel)
	}
	scroll(100)
	var last int
	h.do(func() { last = lastPage(h.l.spans()) })
	if first, _ := drawn(); first != all[last] {
		t.Errorf("to the end: first %q, want %q", first, all[last])
	}
	h.do(func() { h.v.Events.Hover(1) })
	var picked string
	h.do(func() { picked = h.l.results[h.l.sel].Title })
	if _, sel := drawn(); sel != 1 || picked != all[last+1] {
		t.Errorf("hover after a scroll: selected row %d, %q", sel, picked)
	}

	// the panel: a remote has more actions than fit
	h.do(h.l.Show)
	h.typeText("gdr")
	h.press(view.KeyActions, 0)
	var actions []string
	h.do(func() {
		for _, a := range h.l.panel.actions {
			actions = append(actions, a.Name)
		}
	})
	if len(actions) <= view.MaxRows {
		t.Fatalf("panel: %q", actions)
	}
	scroll(100)
	if first, sel := drawn(); first != actions[len(actions)-view.MaxRows] || sel != 0 {
		t.Errorf("panel to the end: first %q, selected row %d", first, sel)
	}
	h.do(func() { h.v.Events.Click(view.MaxRows - 1) })
	if c := h.call(); c != "clipboard gdrive:" {
		t.Errorf("the panel's last action clicked: %q", c)
	}
}

func TestTabCompletesARemote(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.typeText("copy gdr")
	var at int
	h.do(func() {
		for i, r := range h.l.results {
			if r.Title == "gdrive:" {
				at = i
			}
		}
		h.l.sel = at
	})
	h.press(view.KeyTab, 0)
	if h.v.Query != "copy gdrive:" {
		t.Errorf("tab: %q", h.v.Query)
	}
}

func TestBlur(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	h.do(func() { h.v.Events.Blur() })
	if !h.v.Shown {
		t.Fatal("a blur right after showing is the show's own")
	}
	h.do(func() { h.l.shownAt = time.Now().Add(-time.Second) })
	h.do(func() { h.v.Events.Blur() })
	if h.v.Shown {
		t.Error("a later blur hides")
	}
}

// selectRow selects the result titled title, and reports whether there is one.
func (h *harness) selectRow(title string) bool {
	found := false
	h.do(func() {
		for i, r := range h.l.results {
			if r.Title == title {
				h.l.sel, found = i, true
			}
		}
	})
	return found
}

// noCall fails if any platform call is made within a short time.
func (h *harness) noCall(what string) {
	h.t.Helper()
	select {
	case c := <-h.calls:
		h.t.Errorf("%s: %q", what, c)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestStopAsksInTheLauncher: an action that stops something asks for confirmation in the
// launcher first. Cancel (or Esc) goes back to the results. Confirming runs the action with the
// launcher still up, and the outcome appears in the status corner.
func TestStopAsksInTheLauncher(t *testing.T) {
	h := newHarness(t)
	everything := &stopAll{}
	h.do(func() { h.l.state = source{mounted: true, everything: everything} })
	h.do(h.l.Show)
	h.typeText("mount")
	if !h.selectRow("gdrive: → /Volumes/gdrive") {
		t.Fatalf("no mount row: %q", h.v.Titles())
	}
	h.press(view.KeyActions, 0)
	h.do(func() { h.v.Type("unmount") })
	h.press(view.KeyEnter, 0)
	if h.v.Last.Placeholder != "Unmount /Volumes/gdrive?" || !slices.Equal(h.v.Titles(), []string{"Unmount", "Cancel"}) || !h.v.Last.Rows[0].Danger {
		t.Fatalf("question: %q, %q", h.v.Last.Placeholder, h.v.Titles())
	}
	h.noCall("asked: the stop ran")
	h.press(view.KeyEsc, 0)
	if !h.v.Shown || h.v.Last.Placeholder != placeholder || h.v.Query != "mount" {
		t.Fatalf("esc: shown %v, placeholder %q, query %q", h.v.Shown, h.v.Last.Placeholder, h.v.Query)
	}

	// the stop row asks too, and Enter confirms and runs it with the launcher up
	h.settle()
	if !h.selectRow("Unmount /Volumes/gdrive") {
		t.Fatalf("no Unmount row: %q", h.v.Titles())
	}
	h.press(view.KeyEnter, 0)
	if h.v.Last.Placeholder != "Unmount /Volumes/gdrive?" {
		t.Fatalf("question: %q", h.v.Last.Placeholder)
	}
	h.press(view.KeyEnter, 0)
	// read on the main thread, because the stop fails at once and draws its failure there
	var shown bool
	var shownPlaceholder, query string
	h.do(func() { shown, shownPlaceholder, query = h.v.Shown, h.v.Last.Placeholder, h.v.Query })
	if !shown || shownPlaceholder != placeholder || query != "mount" {
		t.Fatalf("answered: shown %v, placeholder %q, query %q", shown, shownPlaceholder, query)
	}
	// there is no core here, so the stop fails and shows the error in red
	deadline := time.Now().Add(2 * time.Second)
	for {
		var st view.Status
		h.do(func() { st = h.v.Last.Status })
		if st.Kind == view.StatusError {
			if st.Text != "Unmount failed: the core is not ready" {
				t.Errorf("status %q", st.Text)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no failure in the corner: %+v", st)
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.noCall("a failure with the launcher up: a dialog")
}

// TestOpeningAWindowActivates: an action that opens a window makes the app active during the key
// press. An action that doesn't (such as a copy) leaves the focus in the user's previous app.
func TestOpeningAWindowActivates(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.typeText("copy")
	h.press(view.KeyEnter, 0)
	if c := h.call(); c != "window Copy /copy" || h.activated.Load() != 1 {
		t.Fatalf("Open Copy: %q, activated %d", c, h.activated.Load())
	}
	h.do(h.l.Show)
	h.typeText("gdr")
	h.press(view.KeyActions, 0)
	h.do(func() { h.v.Type("copy name") })
	h.press(view.KeyEnter, 0)
	if c := h.call(); c != "clipboard gdrive:" || h.activated.Load() != 1 {
		t.Errorf("Copy Name: %q, activated %d", c, h.activated.Load())
	}
}

// TestTheCornerListensToOneAction: the status corner shows only the last action run. An earlier
// action, or one still running when the launcher closes, ends without a status or notification.
func TestTheCornerListensToOneAction(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	stay := func(name string, release chan struct{}) (engine.Result, engine.Action) {
		a := engine.Action{ID: name, Name: name, Stay: true, Run: func(_ context.Context, env engine.Env) error {
			env.Status(engine.StatusWorking, name+" working")
			<-release
			env.Status(engine.StatusDone, name+" done")
			return errors.New(name + " broke")
		}}
		return engine.Result{ID: name, Title: name, Actions: []engine.Action{a}}, a
	}
	status := func() view.Status {
		var st view.Status
		h.do(func() { st = h.v.Last.Status })
		return st
	}
	waitFor := func(text string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for status().Text != text {
			if time.Now().After(deadline) {
				t.Fatalf("status %q, want %q", status().Text, text)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	first, second := make(chan struct{}), make(chan struct{})
	h.do(func() { r, a := stay("first", first); h.l.perform(r, a, "") })
	waitFor("first working")
	h.do(func() { r, a := stay("second", second); h.l.perform(r, a, "") })
	waitFor("second working")
	close(first)
	time.Sleep(50 * time.Millisecond)
	if st := status(); st.Text != "second working" {
		t.Fatalf("the first action, run before, was heard: %+v", st)
	}
	close(second)
	waitFor("second failed: second broke")
	if status().Kind != view.StatusError {
		t.Errorf("a failure: %+v", status())
	}

	third := make(chan struct{})
	h.do(func() { r, a := stay("third", third); h.l.perform(r, a, "") })
	waitFor("third working")
	h.do(h.l.Hide)
	close(third)
	h.noCall("an action ending with the launcher closed")
	h.do(h.l.Show)
	h.settle()
	if st := status(); st.Kind != view.StatusNone {
		t.Errorf("shown again: %+v", st)
	}
}

// TestStopEverything: the stop button is enabled while something runs. It (and ⌘.) asks for
// confirmation, saying how much it stops, and Cancel closes the question. Confirming makes one
// call to the core's StopAll, and the status corner says what stopped.
func TestStopEverything(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	if h.v.Last.Running {
		t.Fatal("nothing runs: the stop button is armed")
	}
	h.do(func() { h.v.Events.StopAll() })
	if h.v.Last.Status.Text != "Nothing is running." {
		t.Errorf("stop with nothing running: %+v", h.v.Last.Status)
	}
	everything := &stopAll{}
	h.do(func() { h.l.state = source{mounted: true, everything: everything} })
	h.typeText("co")
	if !h.v.Last.Running {
		t.Fatal("a mount runs: the stop button isn't armed")
	}
	h.do(func() { h.v.Events.StopAll() })
	if h.v.Last.Placeholder != "Stop a mount?" || !slices.Equal(h.v.Titles(), []string{"Stop Everything", "Cancel"}) {
		t.Fatalf("question: %q, %q", h.v.Last.Placeholder, h.v.Titles())
	}
	h.press(view.KeyDown, 0)
	h.press(view.KeyEnter, 0)
	if h.v.Last.Placeholder != placeholder || h.v.Query != "co" {
		t.Fatalf("cancelled: placeholder %q, query %q", h.v.Last.Placeholder, h.v.Query)
	}
	if !h.press(view.KeyRow, '.') || h.v.Last.Placeholder != "Stop a mount?" {
		t.Fatalf("⌘.: placeholder %q", h.v.Last.Placeholder)
	}
	h.noCall("asked: anything ran")
	if everything.calls.Load() != 0 {
		t.Fatal("asked: StopAll ran")
	}
	h.press(view.KeyEnter, 0)
	deadline := time.Now().Add(2 * time.Second)
	for {
		var st view.Status
		h.do(func() { st = h.v.Last.Status })
		if st.Text == "Stopped a mount." {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status %+v after confirming", st)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := everything.calls.Load(); n != 1 {
		t.Fatalf("StopAll ran %d times", n)
	}
}

// TestEnterWaitsForTheAnswer: Enter pressed before the text's first results arrive runs the first
// row of those results, not of the older rows drawn.
func TestEnterWaitsForTheAnswer(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	h.do(func() {
		h.v.Type("move")
		h.v.Press(view.KeyEvent{Key: view.KeyEnter})
	})
	if c := h.call(); c != "window Move /move" {
		t.Fatalf("enter: %q", c)
	}
	// an edit after the Enter cancels it
	h.do(h.l.Show)
	h.settle()
	h.do(func() {
		h.v.Type("copy")
		h.v.Press(view.KeyEvent{Key: view.KeyEnter})
		h.v.Type("sync")
	})
	h.settle()
	h.noCall("Enter, then an edit")
}

func TestTildeBrowsesHome(t *testing.T) {
	h := newHarness(t)
	home := filepath.Join(string(filepath.Separator), "home", "me")
	h.do(func() { h.l.home = home })
	h.do(h.l.Show)
	if rows := h.typeText("~"); !slices.Contains(rows, "Browse "+home) {
		t.Errorf("~: %q", rows)
	}
}

// TestTabThroughAFolderWithSpaces: Tab on a folder with a space opens a quote and leaves it
// open, and the next Tab continues inside it.
func TestTabThroughAFolderWithSpaces(t *testing.T) {
	h := newHarness(t)
	h.do(func() {
		h.l.state = source{list: func(_ context.Context, dir string, page func([]engine.Entry)) error {
			switch dir {
			case "gdrive:":
				page([]engine.Entry{{Name: "My Folder", Path: "gdrive:My Folder", Dir: true}})
			case "gdrive:My Folder/":
				page([]engine.Entry{{Name: "inside", Path: "gdrive:My Folder/inside", Dir: true}})
			}
			return nil
		}}
	})
	h.do(h.l.Show)
	h.typeText("copy gdrive:My")
	if !h.selectRow("My Folder/") {
		t.Fatalf("no My Folder/: %q", h.v.Titles())
	}
	h.press(view.KeyTab, 0)
	if h.v.Query != `copy "gdrive:My Folder/` {
		t.Fatalf("first Tab: %q", h.v.Query)
	}
	h.settle()
	if !h.selectRow("inside/") {
		t.Fatalf("no inside/: %q", h.v.Titles())
	}
	h.press(view.KeyTab, 0)
	if h.v.Query != `copy "gdrive:My Folder/inside/` {
		t.Fatalf("second Tab: %q", h.v.Query)
	}
}

// TestTabThroughAFolderWithAQuote: a folder whose name contains a quote is completed inside a
// different kind of quote, so the path stays whole.
func TestTabThroughAFolderWithAQuote(t *testing.T) {
	h := newHarness(t)
	h.do(func() {
		h.l.state = source{list: func(_ context.Context, dir string, page func([]engine.Entry)) error {
			if dir == "gdrive:" {
				page([]engine.Entry{{Name: `My "Best" Photos`, Path: `gdrive:My "Best" Photos`, Dir: true}})
			}
			return nil
		}}
	})
	h.do(h.l.Show)
	for _, typed := range []string{"copy gdrive:My", `copy "gdrive:My`} {
		h.typeText(typed)
		if !h.selectRow(`My "Best" Photos/`) {
			t.Fatalf("%s: no folder: %q", typed, h.v.Titles())
		}
		h.press(view.KeyTab, 0)
		if h.v.Query != `copy 'gdrive:My "Best" Photos/` {
			t.Fatalf("%s: Tab: %q", typed, h.v.Query)
		}
		h.settle()
		var typing string
		h.do(func() {
			if p := h.l.query.Typing; p != nil {
				typing = p.Text
			}
		})
		if typing != `gdrive:My "Best" Photos/` {
			t.Errorf("%s: the path read %q", typed, typing)
		}
	}
}

// TestDrop: dropped files are named at the top of the launcher, and the text chooses where they
// go. Enter opens Copy with all of them. Esc clears them, and the next Esc hides.
func TestDrop(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	h.do(func() { h.v.Events.Drop([]string{"/tmp/a.jpg", "/tmp/b.jpg"}) })
	rows := h.settle()
	if h.v.Last.Header != "2 items dropped: a.jpg, b.jpg" || h.v.Last.Placeholder != dropPlaceholder {
		t.Fatalf("header %q, placeholder %q", h.v.Last.Header, h.v.Last.Placeholder)
	}
	if !slices.Contains(rows, "Copy 2 items to gdrive:") || !slices.Contains(rows, "Copy 2 items to…") || slices.Contains(rows, "Copy") {
		t.Fatalf("dropped: %q", rows)
	}
	rows = h.typeText("gdrive:Backup")
	if rows[0] != "Copy 2 items to gdrive:Backup" || rows[1] != "Move 2 items to gdrive:Backup" {
		t.Fatalf("typed a destination: %q", rows)
	}
	h.press(view.KeyEnter, 0)
	want := "window Copy /copy?initialDestination=gdrive%3ABackup&initialSource=%2Ftmp%2Fa.jpg&initialSource=%2Ftmp%2Fb.jpg"
	if c := h.call(); c != want {
		t.Fatalf("enter: %q", c)
	}

	h.do(h.l.Show)
	if rows := h.settle(); rows[0] != "Run" || h.v.Last.Header != "" {
		t.Fatalf("the next showing kept the drop: %q, %q", rows, h.v.Last.Header)
	}
	h.do(func() { h.v.Events.Drop([]string{"/tmp/a.jpg"}) })
	h.settle()
	if h.v.Last.Header != "Dropped: a.jpg" {
		t.Fatalf("one file: %q", h.v.Last.Header)
	}
	h.press(view.KeyEsc, 0)
	if rows := h.settle(); !h.v.Shown || h.v.Last.Header != "" || rows[0] != "Run" {
		t.Fatalf("Esc lets the files go, keeping the launcher: shown %v, %q", h.v.Shown, rows)
	}
	h.press(view.KeyEsc, 0)
	if h.v.Shown {
		t.Fatal("the second Esc hides")
	}
}

// TestClipboard: a link that was just copied comes first for the empty query. Once used, it isn't
// offered again until the clipboard changes.
func TestClipboard(t *testing.T) {
	h := newHarness(t)
	clip, id := engine.Clip{Text: "https://example.com/files/movie.mkv"}, "1"
	h.l.p.ClipboardPeek = func() (engine.Clip, string) { return clip, id }
	h.do(h.l.Show)
	if rows := h.settle(); rows[0] != "Download movie.mkv" {
		t.Fatalf("shown: %q", rows)
	}
	if rows := h.typeText("co"); slices.Contains(rows, "Download movie.mkv") {
		t.Fatalf("a query hides it: %q", rows)
	}
	h.typeText("")
	h.press(view.KeyEnter, 0)
	if c := h.call(); c != "window Download /download?initialUrl=https%3A%2F%2Fexample.com%2Ffiles%2Fmovie.mkv" {
		t.Fatalf("enter: %q", c)
	}
	h.do(h.l.Show)
	if rows := h.settle(); rows[0] == "Download movie.mkv" {
		t.Fatal("offered again for the same copy")
	}
	h.do(h.l.Hide)
	id = "2"
	h.do(h.l.Show)
	if rows := h.settle(); rows[0] != "Download movie.mkv" {
		t.Fatalf("a new copy: %q", rows)
	}
}

// TestRowShortcutWithoutARow: ⌘ with a row letter that has no row isn't handled by the launcher,
// so the text box and the menus get it. The same holds in the panel.
func TestRowShortcutWithoutARow(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	rows := h.typeText("copy")
	if rowIndex('u') < len(rows) {
		t.Fatalf("⌘U has a row: %q", rows)
	}
	if h.press(view.KeyRow, 'u') {
		t.Error("⌘U with no such row was taken")
	}
	h.typeText("gdr")
	h.press(view.KeyActions, 0)
	if h.press(view.KeyRow, 'u') {
		t.Error("⌘U with no such action was taken")
	}
	if !h.v.Shown || h.v.Last.Header != "Actions for gdrive" {
		t.Errorf("the panel moved: shown %v, header %q", h.v.Shown, h.v.Last.Header)
	}
	h.noCall("⌘U")
	if !h.press(view.KeyRow, '1') {
		t.Error("⌘1 on the panel's first action wasn't taken")
	}
}

// TestCloseDismisses: closing the window (Alt+F4) hides the launcher at once, while Esc would only
// close the panel or clear the dropped files. The query comes back at the next Show.
func TestCloseDismisses(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.typeText("gdr")
	h.press(view.KeyActions, 0)
	if !h.press(view.KeyClose, 0) || h.v.Shown {
		t.Fatalf("closed over the panel: shown %v", h.v.Shown)
	}
	h.do(h.l.Show)
	h.settle()
	if h.v.Query != "gdr" || h.v.Last.Header != "" {
		t.Errorf("shown again: query %q, header %q", h.v.Query, h.v.Last.Header)
	}
	h.do(func() { h.v.Events.Drop([]string{"/tmp/a.jpg"}) })
	h.settle()
	if h.press(view.KeyClose, 0); h.v.Shown {
		t.Fatal("closed with files dropped: still shown")
	}
}

// TestShowOverThePanel: showing the launcher again while the panel is open closes the panel and
// restores the query.
func TestShowOverThePanel(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.typeText("gdr")
	h.press(view.KeyActions, 0)
	h.do(func() { h.v.Type("edit") })
	h.do(h.l.Show)
	h.settle()
	if h.v.Query != "gdr" || h.v.Last.Header != "" {
		t.Errorf("query %q, header %q", h.v.Query, h.v.Last.Header)
	}
}

// TestLateClipboardKeepsTheSelection: a clipboard that becomes known only after the first results
// adds its suggestion without moving the selection off the row the user picked. Enter pressed in
// the meantime runs the row that is drawn as selected.
func TestLateClipboardKeepsTheSelection(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	h.l.p.ClipboardPeek = func() (engine.Clip, string) {
		<-release
		return engine.Clip{Text: "https://example.com/files/movie.mkv"}, "1"
	}
	h.do(h.l.Show)
	rows := h.settle()
	if rows[0] != "Run" {
		t.Fatalf("before the clipboard: %q", rows)
	}
	h.press(view.KeyDown, 0)
	h.press(view.KeyDown, 0)
	picked := rows[2]
	if picked != "gdrive" {
		t.Fatalf("third row %q, want gdrive", picked)
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if rows = h.settle(); rows[0] == "Download movie.mkv" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no suggestion: %q", rows)
		}
		time.Sleep(5 * time.Millisecond)
	}
	var selected string
	h.do(func() { selected = h.l.results[h.l.sel].Title })
	if selected != picked {
		t.Errorf("selected %q, want %q", selected, picked)
	}

	// Enter while the clipboard is still being read runs the row drawn as selected
	h.do(func() {
		h.l.rerun()
		if !h.l.fresh {
			t.Error("the rows drawn stopped being the text's")
		}
		h.v.Press(view.KeyEvent{Key: view.KeyEnter})
	})
	if c := h.call(); c != "full Commander /commander?path=gdrive%3A" {
		t.Errorf("enter: %q", c)
	}
}

// TestAnActionThatPanics: an action that panics fails, the failure is shown in the corner, and
// the launcher keeps working.
func TestAnActionThatPanics(t *testing.T) {
	h := newHarness(t)
	h.do(h.l.Show)
	h.settle()
	a := engine.Action{ID: "broken", Name: "Broken", Stay: true, Run: func(context.Context, engine.Env) error {
		var m map[string]int
		m["x"]++
		return nil
	}}
	h.do(func() { h.l.perform(engine.Result{ID: "broken", Title: "Broken", Actions: []engine.Action{a}}, a, "") })
	deadline := time.Now().Add(2 * time.Second)
	for {
		var st view.Status
		h.do(func() { st = h.v.Last.Status })
		if st.Kind == view.StatusError {
			if st.Text != "Broken failed: something went wrong" {
				t.Errorf("status %q", st.Text)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no failure in the corner: %+v", st)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if rows := h.typeText("copy"); rows[0] != "Copy" {
		t.Errorf("after the panic: %q", rows)
	}
}

// following records whether transfer progress is being followed.
type following struct {
	source
	on *atomic.Bool
}

func (f following) FollowProgress(on bool) { f.on.Store(on) }

func TestProgressIsFollowedWhileUp(t *testing.T) {
	h := newHarness(t)
	on := &atomic.Bool{}
	h.do(func() { h.l.state = following{on: on} })
	h.do(h.l.Show)
	h.settle()
	if !on.Load() {
		t.Fatal("shown: not followed")
	}
	h.do(h.l.Hide)
	if on.Load() {
		t.Fatal("hidden: still followed")
	}
}
