// Package launcher is the command palette that opens with the global shortcut. It lists commands,
// remotes, paths and what is running. The engine (engine, providers) finds results for a query,
// state keeps a copy of the core's state, and a view (view/<os>) draws the window with the OS's
// own toolkit. Launcher sits between them and makes every decision: the selection, the keys, the
// ⌘K panel, completion, and when to hide. Its state lives on the main thread, because the view's
// events arrive there and the engine's results are sent there.
package launcher

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/engine/providers"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/match"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Platform is what the app gives the launcher: ways to open windows, the OS's services, and access
// to the main thread.
type Platform struct {
	OpenWindow func(name, url string)
	OpenFull   func(name, url string)
	Clipboard  func(text string)
	Reveal     func(path string)
	OpenURL    func(url string)
	Notify     func(title, body string)
	// Activate prepares the focus for a window that an action opens, just before the launcher
	// hides. It runs on the main thread while the user's key press or click is being handled,
	// because that is when the OS lets an app take the focus. On macOS it makes the app active
	// (macOS 14 and later refuse an activation requested later). On Windows it hands the focus
	// over: the foreground isn't given back to the app the user was in, and the new window comes
	// to the front as it opens. Nil when it isn't needed.
	Activate func()
	Quit     func()
	// Main runs fn on the main thread. Called from another thread, fn runs as soon as the main
	// thread gets to it. Called on the main thread, fn runs at once, before Main returns (Wails'
	// dispatch runs it inline), so the main thread can't use Main to defer fn. MainSync also runs
	// fn on the main thread, but waits for it. On the main thread it runs fn inline as well.
	Main     func(fn func())
	MainSync func(fn func())
	// Mod is the modifier shown in the row shortcuts: "⌘" or "Ctrl+".
	Mod string
	// ClipboardPeek returns what can be learned about the clipboard without asking the user: its
	// text, or only that it holds a link (macOS asks the user before an app reads it). It also
	// returns an id that tells one copy from the next. Called off the main thread. Nil means no
	// clipboard suggestion.
	ClipboardPeek func() (clip engine.Clip, id string)
	// ClipboardText reads the clipboard's text after the user asked for it. Called off the main
	// thread.
	ClipboardText func() string
}

// Source is the state that the launcher reads and acts on. The app passes a state.State.
type Source interface {
	Data() *engine.Data
	Services() engine.Services
	RefreshIfOlder(ctx context.Context, age time.Duration)
	// FollowProgress turns on or off the tracking of running transfers' progress. It is on while
	// the launcher is shown. Each change counts as a state change, at most once a second.
	FollowProgress(on bool)
	// OnChange registers fn to be called, on any goroutine, when the state changes.
	OnChange(fn func())
}

const (
	blurGrace    = 300 * time.Millisecond // a blur this soon after Show comes from the show itself
	spinnerAfter = 500 * time.Millisecond
	staleAfter   = 30 * time.Second // state older than this is reloaded when the launcher shows
	doneFor      = 4 * time.Second  // how long the status corner shows that an action succeeded
	failedFor    = 12 * time.Second // how long it shows that an action failed
	// clipboardWait is how long Show waits for the clipboard before running the query without it.
	// Reading the clipboard may wait on the app that owns it (X11, Wayland).
	clipboardWait = 50 * time.Millisecond
)

type Launcher struct {
	p        Platform
	log      *slog.Logger
	state    Source
	usage    *usageStore
	engine   *engine.Engine // runs typed queries
	drops    *engine.Engine // runs while files are dropped, and only offers where they can go
	complete *providers.Completion
	view     view.View
	home     string // this machine's home folder, which ~ stands for; "" if there is none

	// on the main thread only
	text    string
	query   engine.Query // the query that results belong to
	results []engine.Result
	cursor       // the selection in results, and the first row drawn
	fresh   bool // results belong to the current text (false between an edit and its first results)
	// enter is set when Enter was pressed before the text's first results arrived. The first row
	// of those results runs when they arrive.
	enter   bool
	busy    bool
	started time.Time
	panel   *panel
	shownAt time.Time
	at      *view.Placement
	// status is shown in the status corner. statusSeq tells one status from the next, so a timer
	// clears only its own. acting is the one action the corner listens to: the last one run, until
	// the launcher closes. running is true when something is running, which enables the
	// stop-everything button.
	status    view.Status
	statusSeq uint64
	acting    *env
	running   bool
	cancel    context.CancelFunc
	seq       uint64
	// dropped holds the files dropped on the launcher, until Esc or Hide
	dropped []engine.Path
	// clip is what was known about the clipboard at the last Show, and clipID tells it apart from
	// the next copy. clipUsed is the copy whose suggestion was run, so it isn't offered again.
	clip             engine.Clip
	clipID, clipUsed string
}

// cursor is the selection in a list and the first row drawn.
type cursor struct{ sel, off int }

// panel is either the ⌘K panel, which lists a result's actions filtered by what is typed in it, or
// a question asked before an action runs, whose rows are the action and Cancel.
type panel struct {
	result  engine.Result
	all     []engine.Action // the actions before filtering
	actions []engine.Action
	cursor
	saved    string // the query, restored when the panel closes
	question string // the question the panel asks; "" for the ⌘K panel
}

// cancelID is the ID of the Cancel row of a question (see ask).
const cancelID = "cancel"

func New(p Platform, log *slog.Logger, h Source, history History) *Launcher {
	c := providers.NewCompletion()
	home, _ := os.UserHomeDir() // with no home folder, ~ isn't a path
	l := &Launcher{p: p, log: log, state: h, usage: newUsageStore(history, log),
		engine: engine.New(providers.All(c)...), drops: engine.New(providers.Drops(c)...), complete: c, home: home}
	l.engine.Panicked, l.drops.Panicked = l.panicked, l.panicked
	h.OnChange(func() { p.Main(l.stateChanged) })
	return l
}

// panicked logs a panic that the launcher recovered from, with its stack. It runs in the
// deferred recover, while the panic's frames are still on the stack.
func (l *Launcher) panicked(where string, v any) {
	l.log.Error("the launcher recovered from a panic", "where", where, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
}

// goSafe runs fn on its own goroutine. An unrecovered panic there would end the whole app,
// including the core that runs inside it. goSafe logs the panic instead, and only fn's work
// is lost.
func (l *Launcher) goSafe(where string, fn func()) {
	go func() {
		defer func() {
			if v := recover(); v != nil {
				l.panicked(where, v)
			}
		}()
		fn()
	}()
}

func (l *Launcher) Attach(v view.View) { l.view = v }

func (l *Launcher) Events() view.Events {
	return view.Events{
		Query:    l.onQuery,
		Key:      l.onKey,
		Hover:    l.onHover,
		Click:    l.onClick,
		Scroll:   l.onScroll,
		Moved:    func(at view.Placement) { l.at = &at },
		Blur:     l.onBlur,
		Drop:     l.onDrop,
		StopAll:  l.onStopAll,
		Panicked: l.panicked,
	}
}

// Visible reports whether the launcher is shown. Main thread.
func (l *Launcher) Visible() bool { return l.view != nil && l.view.Visible() }

// Show shows the launcher with its text selected, and runs the query again. Main thread.
func (l *Launcher) Show() {
	if l.view == nil {
		return
	}
	l.state.RefreshIfOlder(context.Background(), staleAfter)
	l.usage.load()
	if l.panel != nil {
		// Shown again while a panel was open: restore the query, as when the panel closes.
		l.text = l.panel.saved
		l.panel = nil
	}
	l.view.Show(l.at)
	l.view.SetQuery(l.text, true)
	l.shownAt = time.Now()
	l.state.FollowProgress(true)
	l.peekClipboardAndRun()
}

// peekClipboardAndRun runs the query once the clipboard is known, so its suggestion can be
// included. If the clipboard takes longer than clipboardWait, the query runs without it, and
// runs again once the clipboard is known.
func (l *Launcher) peekClipboardAndRun() {
	if l.p.ClipboardPeek == nil {
		l.run()
		return
	}
	// Until the results arrive, the rows drawn are from the last Show. They are no longer current,
	// and results from an older query that are still on their way are ignored.
	l.seq++
	l.fresh, l.busy = false, true
	type peek struct {
		clip engine.Clip
		id   string
	}
	got := make(chan peek, 1)
	l.goSafe("clipboard peek", func() {
		var p peek
		// if the peek panics, the clipboard counts as unknown
		defer func() { got <- p }()
		p.clip, p.id = l.p.ClipboardPeek()
	})
	go func() {
		set := func(p peek) bool {
			changed := p.id != l.clipID || p.clip != l.clip
			l.clip, l.clipID = p.clip, p.id
			return changed
		}
		select {
		case p := <-got:
			l.p.Main(func() {
				set(p)
				l.run()
			})
		case <-time.After(clipboardWait):
			l.p.Main(l.run)
			p := <-got
			l.p.Main(func() {
				if set(p) && l.Visible() && l.panel == nil {
					l.rerun()
				}
			})
		}
	}()
}

// Hide hides the launcher and keeps its text. Main thread.
func (l *Launcher) Hide() {
	if !l.Visible() {
		return
	}
	if l.cancel != nil {
		l.cancel()
	}
	l.enter = false
	l.complete.Reset()
	if l.panel != nil {
		l.text = l.panel.saved
		l.panel = nil
	}
	if l.dropped != nil {
		// The dropped files belong to this Show only. The next Show starts with an empty text.
		l.dropped, l.text = nil, ""
	}
	// Once closed, the status corner stops listening to actions. An action that is still running
	// finishes without updating it.
	l.acting = nil
	l.statusSeq++
	l.status = view.Status{}
	l.state.FollowProgress(false)
	l.view.Hide()
}

// Toggle shows the launcher, or hides it. Main thread.
func (l *Launcher) Toggle() {
	if l.Visible() {
		l.Hide()
	} else {
		l.Show()
	}
}

func (l *Launcher) onQuery(text string) {
	l.text, l.enter = text, false
	if l.panel != nil {
		l.filterPanel()
		return
	}
	l.run()
}

// run runs the query for the current text. The old rows stay until the first results arrive,
// usually within a frame or two. The spinner shows only if the results take longer than
// spinnerAfter.
func (l *Launcher) run() { l.answer(false) }

// rerun runs the same text again because something around it changed, such as a clipboard that
// became known late. Meanwhile the rows drawn still belong to the text, so Enter runs the row the
// user sees. The new results keep the selection on the same result. Only a selection that is
// still on the first row moves to whatever comes first now. If the rows drawn belong to an older
// text, rerun is the same as run.
func (l *Launcher) rerun() { l.answer(l.fresh) }

// stateChanged runs the query again after the core's state changed (a mount started, a transfer
// ended), keeping the selection on the same result.
func (l *Launcher) stateChanged() {
	if !l.Visible() {
		return
	}
	_, l.running = providers.StopEverything(l.state.Data())
	if l.panel != nil {
		l.render()
		return
	}
	l.rerun()
}

// LanguageChanged draws the launcher again in the app's language. The providers translate the
// rows when they make them, and render translates the launcher's own text, so the query runs
// again. A hidden launcher runs it when it shows. Main thread.
func (l *Launcher) LanguageChanged() {
	if !l.Visible() {
		return
	}
	if l.panel != nil {
		// A question or a row's actions were made in the old language, so they close.
		l.closePanel()
	}
	l.rerun()
}

func (l *Launcher) answer(keep bool) {
	if l.cancel != nil {
		l.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel
	l.seq++
	id := l.seq
	d := l.state.Data() // the launcher's own copy, so it can set Home on it
	d.Home = l.home
	q := engine.Parse(l.text, d.Remotes, d.Home)
	q.Dropped = l.dropped
	e := l.engine
	if len(l.dropped) > 0 {
		e = l.drops
	}
	if l.clipID == "" || l.clipID != l.clipUsed {
		q.Clipboard = l.clip
	}
	usage := l.usage.snapshot()
	l.started, l.busy = time.Now(), true
	if !keep {
		l.fresh = false
	}
	l.goSafe("query", func() { e.Run(ctx, q, d, usage, l.answered(id, q, d, keep)) })
	time.AfterFunc(spinnerAfter, func() {
		l.p.Main(func() {
			if id == l.seq && l.busy && l.panel == nil {
				l.render()
			}
		})
	})
}

// answered returns the engine's emit function for query run id (of q, over d). It sends each
// snapshot to the main thread, where only the newest run's results are used.
func (l *Launcher) answered(id uint64, q engine.Query, d *engine.Data, keep bool) func([]engine.Result, bool) {
	answered := false
	return func(rs []engine.Result, final bool) {
		l.p.Main(func() {
			if id != l.seq {
				return // a newer query has started
			}
			first := !answered
			answered = true
			var kept string
			if r, ok := l.selected(); ok && keep && first && l.sel > 0 {
				kept = r.ID
			}
			l.query, l.results, l.fresh, l.busy = q, rs, true, !final
			_, l.running = providers.StopEverything(d)
			switch {
			case kept != "":
				l.sel = max(slices.IndexFunc(rs, func(r engine.Result) bool { return r.ID == kept }), 0)
			case first:
				l.cursor = cursor{}
			}
			l.clamp()
			if l.panel == nil {
				l.render()
			}
			if first && l.enter {
				// An Enter typed ahead runs here, in a block that the main thread runs after the
				// key press was handled. On macOS the window that the row opens may then come up
				// without the focus, because macOS 14 and later may refuse Activate outside the
				// user's event. This is a known limit: the key press can't wait for the results.
				l.enter = false
				l.activate()
			}
		})
	}
}

// cur returns the list that the keys and the mouse work on, and its length. That is the panel's
// actions while the panel is open, and the results otherwise.
func (l *Launcher) cur() (*cursor, int) {
	if l.panel != nil {
		return &l.panel.cursor, len(l.panel.actions)
	}
	return &l.cursor, len(l.results)
}

// spans returns the heights of cur's rows. A result that starts a group is taller, because the
// group's label is drawn above it.
func (l *Launcher) spans() []float64 {
	_, n := l.cur()
	out := make([]float64, n)
	for i := range out {
		out[i] = view.RowH
		if l.panel == nil && startsGroup(l.results, i) {
			out[i] += view.GroupH
		}
	}
	return out
}

// startsGroup reports whether rs[i] is the first result of its group, which gets the group's label.
func startsGroup(rs []engine.Result, i int) bool {
	return rs[i].Group != "" && (i == 0 || rs[i-1].Group != rs[i].Group)
}

func (l *Launcher) clamp() {
	c, n := l.cur()
	if c.sel >= n {
		c.sel = max(n-1, 0)
	}
}

func (l *Launcher) onKey(k view.KeyEvent) bool {
	switch k.Key {
	case view.KeyDown, view.KeyUp:
		l.move(k.Key == view.KeyDown)
	case view.KeyEnter:
		if l.panel == nil && !l.fresh {
			// Typed and entered quickly: the rows drawn still belong to an older text.
			l.enter = true
			break
		}
		l.activate()
	case view.KeyEsc:
		l.enter = false
		switch {
		case l.panel != nil:
			l.closePanel()
		case l.dropped != nil:
			// The first Esc clears the dropped files. The next one hides the launcher.
			l.dropped, l.text = nil, ""
			l.view.SetQuery("", false)
			l.run()
		default:
			l.Hide()
		}
	case view.KeyClose:
		// Hide also closes the panel and clears the dropped files.
		l.enter = false
		l.Hide()
	case view.KeyTab:
		l.completeSelected()
	case view.KeyActions:
		if l.panel != nil {
			l.closePanel()
		} else {
			l.openPanel()
		}
	case view.KeyRow:
		if k.Char == '.' { // ⌘., the stop-everything button
			l.onStopAll()
			break
		}
		// If there is no such row, the key goes to the text box and the menus. Keys such as ⌘Z
		// and ⌘Q never select rows (see view.RowLetters).
		c, n := l.cur()
		i := rowIndex(k.Char)
		if i < 0 || i >= n {
			return false
		}
		c.sel = i
		l.activate()
	default:
		return false
	}
	return true
}

func (l *Launcher) move(down bool) {
	c, n := l.cur()
	if n == 0 {
		return
	}
	if down {
		c.sel = (c.sel + 1) % n
	} else {
		c.sel = (c.sel + n - 1) % n
	}
	l.render()
}

// onHover selects the row under the pointer, except a partly drawn last row. Selecting that row
// would scroll the list under a pointer that hasn't moved.
func (l *Launcher) onHover(row int) {
	c, _ := l.cur()
	if i := row + c.off; i < wholeEnd(l.spans(), c.off) && i != c.sel {
		c.sel = i
		l.render()
	}
}

func (l *Launcher) onClick(row int) {
	c, n := l.cur()
	if i := row + c.off; i < n {
		c.sel = i
		l.activate()
	}
}

// onScroll scrolls the list by n rows and keeps the selection among the rows that are fully
// drawn. A pointer that hasn't moved doesn't select the row that scrolls under it.
func (l *Launcher) onScroll(n int) {
	c, _ := l.cur()
	spans := l.spans()
	top := max(min(c.off+n, lastPage(spans)), 0)
	if top == c.off {
		return
	}
	c.off = top
	c.sel = min(max(c.sel, top), wholeEnd(spans, top)-1)
	l.render()
}

// onStopAll handles the stop-everything button and ⌘. by asking for confirmation in the launcher.
func (l *Launcher) onStopAll() {
	r, ok := providers.StopEverything(l.state.Data())
	if !ok {
		l.setStatus(view.Status{Kind: view.StatusDone, Text: i18n.T("Nothing is running.")})
		return
	}
	query := l.text
	if l.panel != nil {
		query = l.panel.saved
	}
	a, _ := r.Default()
	l.ask(r, a, query)
}

// onDrop handles files dropped on the launcher. The launcher then offers places where they can
// go, and the text chooses among them.
func (l *Launcher) onDrop(paths []string) {
	if len(paths) == 0 {
		return
	}
	l.panel = nil
	l.dropped = make([]engine.Path, len(paths))
	for i, p := range paths {
		l.dropped[i] = engine.Path{Text: p, Local: true}
	}
	l.text = ""
	l.view.SetQuery("", false)
	l.run()
}

func (l *Launcher) onBlur() {
	if !l.Visible() || time.Since(l.shownAt) < blurGrace {
		return
	}
	l.Hide()
}

// rowIndex returns the row that ⌘ with c runs: 1–9 first, then the letters. It returns -1 for
// none.
func rowIndex(c rune) int {
	c = unicode.ToLower(c)
	if c >= '1' && c <= '9' {
		return int(c - '1')
	}
	if i := strings.IndexRune(view.RowLetters, c); i >= 0 {
		return 9 + i
	}
	return -1
}

// rowHint returns the shortcut text shown on row i.
func (l *Launcher) rowHint(i int) string {
	switch {
	case i < 9:
		return l.p.Mod + strconv.Itoa(i+1)
	case i < 9+len(view.RowLetters):
		return l.p.Mod + strings.ToUpper(string(view.RowLetters[i-9]))
	}
	return ""
}

func (l *Launcher) selected() (engine.Result, bool) {
	if l.sel < 0 || l.sel >= len(l.results) {
		return engine.Result{}, false
	}
	return l.results[l.sel], true
}

// completeSelected replaces the path (or word) being typed with the selected result's
// completion, such as a folder entry or a remote's root. The replacement starts where the query
// says the word starts. It does nothing until the text's own results arrive, because until then
// the selection and that start position belong to an older text.
//
// A path with spaces is only one word when quoted. So a completion that contains a space is
// quoted, and so is one that replaces a word starting with a quote. The quote character is one
// that the path doesn't contain, since that would end the path early (quotes have no escapes).
// After a folder the quote stays open, so the user can keep typing (or press Tab) inside it.
// After a file the quote is closed and followed by a space for the next word.
func (l *Launcher) completeSelected() {
	r, ok := l.selected()
	if l.panel != nil || !l.fresh || !ok || r.Complete == "" {
		return
	}
	from := min(l.query.TypingFrom, len(l.text))
	base, word := l.text[:from], l.text[from:]
	done := r.Complete
	const quotes = "\"'`"
	quote := ""
	switch {
	case word != "" && strings.ContainsRune(quotes, rune(word[0])):
		quote = word[:1]
	case strings.ContainsAny(done, " \t"):
		quote = `"`
	}
	if quote != "" && strings.Contains(done, quote) {
		for _, q := range quotes {
			if !strings.ContainsRune(done, q) {
				quote = string(q)
				break
			}
		}
	}
	if quote != "" {
		done = quote + done
		if !folder(r.Complete) {
			done += quote + " "
		}
	}
	l.text = base + done
	l.view.SetQuery(l.text, false)
	l.run()
}

// folder reports whether a completion is a folder (or a remote's root) that the path continues
// into.
func folder(p string) bool {
	return strings.HasSuffix(p, "/") || strings.HasSuffix(p, "\\") || strings.HasSuffix(p, ":")
}

func (l *Launcher) openPanel() {
	l.enter = false
	r, ok := l.selected()
	if !ok || len(r.Actions) == 0 {
		return
	}
	l.panel = &panel{result: r, all: r.Actions, actions: r.Actions, saved: l.text}
	l.text = ""
	l.view.SetQuery("", false)
	l.render()
}

// ask shows a's question in the launcher, as a panel with a and Cancel. query is restored when
// the panel closes.
func (l *Launcher) ask(r engine.Result, a engine.Action, query string) {
	l.enter = false
	choices := []engine.Action{a, {ID: cancelID, Name: i18n.T("Cancel"), Icon: icons.Back}}
	l.panel = &panel{result: r, all: choices, actions: choices, saved: query, question: a.Confirm}
	l.text = ""
	l.view.SetQuery("", false)
	l.render()
}

func (l *Launcher) closePanel() {
	if l.panel == nil {
		return
	}
	l.text = l.panel.saved
	l.panel = nil
	l.view.SetQuery(l.text, false)
	l.render()
}

func (l *Launcher) filterPanel() {
	p := l.panel
	p.actions = nil
	for _, a := range p.all {
		if _, ok := match.Match(l.text, a.Name); ok {
			p.actions = append(p.actions, a)
		}
	}
	p.sel = 0
	l.render()
}

// activate runs the selected result's default action, or the panel's selected action. In a
// question, the action's row runs it without asking again, and Cancel closes the question.
func (l *Launcher) activate() {
	if p := l.panel; p != nil {
		if p.sel >= len(p.actions) {
			return
		}
		switch a := p.actions[p.sel]; {
		case p.question == "":
			l.act(p.result, a, p.saved)
		case a.ID == cancelID:
			l.closePanel()
		default:
			l.perform(p.result, a, p.saved)
		}
		return
	}
	r, ok := l.selected()
	if !ok {
		return
	}
	if a, ok := r.Default(); ok && a.Run != nil {
		l.act(r, a, l.text)
	}
}

// act runs a for r, asking for confirmation first if a has a question.
func (l *Launcher) act(r engine.Result, a engine.Action, query string) {
	if a.Confirm != "" {
		l.ask(r, a, query)
		return
	}
	l.perform(r, a, query)
}

// perform runs a for r. The launcher hides first, so that a window the action opens gets the
// focus. A drill-in action (KeepOpen) leaves the launcher up. So does an action that runs in
// place (Stay), which goes back to the results. The status corner then shows only this action's
// progress, result or failure, until another action runs or the launcher closes.
func (l *Launcher) perform(r engine.Result, a engine.Action, query string) {
	e := &env{l: l, action: a}
	switch {
	case a.Stay:
		l.closePanel()
		l.acting = e
		e.seq = l.setStatus(view.Status{Kind: view.StatusLoading, Text: a.Name + "…"})
	case !a.KeepOpen:
		if a.Opens && l.p.Activate != nil {
			l.p.Activate()
		}
		l.Hide()
	}
	l.goSafe("action "+a.ID, func() {
		if a.Run == nil {
			return
		}
		err := l.runAction(a, e)
		e.finish(err)
		if err != nil {
			l.log.Error("a launcher action failed", "result", r.Title, "action", a.Name, "error", err)
			return
		}
		if r.Key != "" {
			l.usage.record(r.Key, query)
		}
	})
	if strings.HasPrefix(r.Key, "clip:") {
		l.clipUsed = l.clipID // this copy's suggestion has been used
	}
}

// errBroke is the error returned for an action that panicked. The panic itself is reported.
var errBroke = errs.New("something went wrong")

// runAction runs a. If a panics, the panic is reported and runAction returns errBroke.
func (l *Launcher) runAction(a engine.Action, e *env) (err error) {
	defer func() {
		if v := recover(); v != nil {
			l.panicked("action "+a.ID, v)
			err = errBroke
		}
	}()
	return a.Run(context.Background(), e)
}

// setStatus shows s in the status corner and returns a sequence number that tells it apart from
// the next status. A success or failure is cleared after a while. A progress message stays until
// the action reports something new.
func (l *Launcher) setStatus(s view.Status) uint64 {
	l.statusSeq++
	seq := l.statusSeq
	l.status = s
	var after time.Duration
	switch s.Kind {
	case view.StatusDone:
		after = doneFor
	case view.StatusError:
		after = failedFor
	}
	if after > 0 {
		time.AfterFunc(after, func() {
			l.p.Main(func() {
				if l.statusSeq == seq {
					l.clearStatus()
				}
			})
		})
	}
	l.render()
	return seq
}

func (l *Launcher) clearStatus() {
	l.statusSeq++
	l.status = view.Status{}
	l.render()
}

// render draws the results (or the panel) with the selection in view.
func (l *Launcher) render() {
	if l.view == nil {
		return
	}
	// i18n: The placeholder of the launcher's search box.
	s := view.Snapshot{Placeholder: i18n.T("Search commands, remotes, or paste a URL"), Status: l.status, Running: l.running}
	if len(l.dropped) > 0 {
		// i18n: The placeholder of the launcher's search box while files are dropped on it.
		s.Placeholder = i18n.T("Where to? Type a remote or a folder")
		s.Header = droppedHeader(l.dropped)
	}
	spans := l.spans()
	if p := l.panel; p != nil {
		s.Placeholder = i18n.T("Search actions…")
		// i18n: The header of the list of a row's actions. %s is the row's title.
		s.Header = i18n.T("Actions for %s", p.result.Title)
		// i18n: Hints at the launcher's foot, after their keys: Enter runs the action, Esc goes back.
		s.Footer = []view.Hint{{Keys: "⏎", Label: i18n.T("Run")}, {Keys: "esc", Label: i18n.T("Back")}}
		if p.question != "" {
			// The question replaces the placeholder in the query box, in its large type, since
			// typing there answers it.
			s.Placeholder, s.Header = p.question, ""
			// i18n: Hints at the launcher's foot, after their keys, while it asks a question: Enter chooses the answer, Esc cancels.
			s.Footer = []view.Hint{{Keys: "⏎", Label: i18n.T("Choose")}, {Keys: "esc", Label: i18n.T("Cancel")}}
		}
		p.off = inView(p.sel, p.off, spans)
		end := drawnEnd(spans, p.off)
		for i := p.off; i < end; i++ {
			a := p.actions[i]
			s.Rows = append(s.Rows, view.Row{Icon: a.Icon, Title: a.Name, Hint: l.rowHint(i), Danger: a.Confirm != ""})
		}
		s.Selected = p.sel - p.off
		s.More = p.off > 0 || end < len(p.actions)
		l.view.Render(s)
		return
	}
	l.off = inView(l.sel, l.off, spans)
	end := drawnEnd(spans, l.off)
	for i := l.off; i < end; i++ {
		r := l.results[i]
		row := view.Row{Icon: r.Icon, Title: r.Title, Bold: r.Match(), Subtitle: r.Subtitle, Tail: r.Tail, Hint: l.rowHint(i)}
		if startsGroup(l.results, i) {
			row.Group = engine.GroupTitle(r.Group)
		}
		if a, ok := r.Default(); ok && a.Confirm != "" {
			row.Danger = true
		}
		s.Rows = append(s.Rows, row)
	}
	s.Selected = l.sel - l.off
	s.More = l.off > 0 || end < len(l.results)
	if len(s.Rows) == 0 {
		s.Selected = -1
	}
	if r, ok := l.selected(); ok {
		if a, ok := r.Default(); ok && a.Run != nil {
			s.Footer = append(s.Footer, view.Hint{Keys: "⏎", Label: a.Name})
		}
		if len(r.Actions) > 1 {
			// i18n: A hint at the launcher's foot, after its key: it lists the row's actions.
			s.Footer = append(s.Footer, view.Hint{Keys: l.p.Mod + "K", Label: i18n.T("Actions")})
		}
		if r.Complete != "" {
			// i18n: A hint at the launcher's foot, after the Tab key: it completes the typed path.
			s.Footer = append(s.Footer, view.Hint{Keys: "⇥", Label: i18n.T("Complete")})
		}
	}
	if s.Status.Kind == view.StatusNone && l.busy && time.Since(l.started) >= spinnerAfter {
		s.Status = view.Status{Kind: view.StatusLoading, Text: i18n.T("Loading…")}
	}
	l.view.Render(s)
}

// inView returns the first row to draw, starting from off, for rows with the heights in spans. It
// moves off as little as possible so that sel is fully drawn and no empty space is left below
// the last row.
func inView(sel, off int, spans []float64) int {
	off = min(off, lastPage(spans), sel)
	for off < sel && wholeEnd(spans, off) <= sel {
		off++
	}
	return max(off, 0)
}

// drawnEnd returns the end of the rows drawn from off. These are the rows that start within the
// list's height. The last one may be cut off at the bottom.
func drawnEnd(spans []float64, off int) int {
	end, h := off, 0.0
	for end < len(spans) && h < view.MaxListH {
		h += spans[end]
		end++
	}
	return end
}

// wholeEnd returns the end of the rows that are fully drawn from off.
func wholeEnd(spans []float64, off int) int {
	end, h := off, 0.0
	for end < len(spans) && h+spans[end] <= view.MaxListH {
		h += spans[end]
		end++
	}
	return end
}

// lastPage returns the first row drawn when the list is scrolled to the end. It is the earliest
// row from which all the remaining rows fit.
func lastPage(spans []float64) int {
	i, h := len(spans), 0.0
	for i > 0 && h+spans[i-1] <= view.MaxListH {
		h += spans[i-1]
		i--
	}
	return i
}

// droppedHeader returns the line shown above the rows while files are dropped. It names the files.
func droppedHeader(ps []engine.Path) string {
	var names []string
	for i, p := range ps {
		if i == 3 {
			names = append(names, "…")
			break
		}
		names = append(names, filepath.Base(p.Text))
	}
	if len(ps) == 1 {
		// i18n: The line above the launcher's rows while a file is dropped on it. %s is its name.
		return i18n.T("Dropped: %s", names[0])
	}
	// i18n: The line above the launcher's rows while files are dropped on it. The last value is their names.
	return i18n.N("%d item dropped: %s", "%d items dropped: %s", len(ps), len(ps), strings.Join(names, ", "))
}
