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
	"sync/atomic"
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
	Mod      string
	// ClipboardPeek returns what can be learned about the clipboard without asking the user: its
	// text, or only that it holds a link (macOS asks the user before an app reads it). It also
	// returns an id that tells one copy from the next. Called off the main thread. Nil means no
	// clipboard suggestion.
	ClipboardPeek func() (clip engine.Clip, id string)
	ClipboardText func() string
}

type Source interface {
	Data() *engine.Data
	Services() engine.Services
	RefreshIfOlder(ctx context.Context, age time.Duration)
	FollowProgress(on bool)
	OnChange(fn func())
}

const (
	blurGrace    = 300 * time.Millisecond
	spinnerAfter = 500 * time.Millisecond
	staleAfter   = 30 * time.Second
	doneFor      = 4 * time.Second
	failedFor    = 12 * time.Second
	// clipboardWait is how long Show waits for the clipboard before running the query without it.
	// Reading the clipboard may wait on the app that owns it (X11, Wayland).
	clipboardWait = 50 * time.Millisecond
)

type Launcher struct {
	p        Platform
	log      *slog.Logger
	state    Source
	usage    *usageStore
	engine   *engine.Engine
	drops    *engine.Engine
	complete *providers.Completion
	view     view.View
	home     string

	staysOpen atomic.Bool

	text    string
	query   engine.Query
	results []engine.Result
	cursor
	fresh            bool
	enter            bool
	busy             bool
	started          time.Time
	panel            *panel
	shownAt          time.Time
	at               *view.Placement
	status           view.Status
	statusSeq        uint64
	acting           *env
	running          bool
	cancel           context.CancelFunc
	seq              uint64
	dropped          []engine.Path
	clip             engine.Clip
	clipID, clipUsed string
}

type cursor struct{ sel, off int }

type panel struct {
	result  engine.Result
	all     []engine.Action
	actions []engine.Action
	cursor
	saved    string
	question string
}

const cancelID = "cancel"

func New(p Platform, log *slog.Logger, h Source, history History) *Launcher {
	c := providers.NewCompletion()
	home, _ := os.UserHomeDir()
	l := &Launcher{p: p, log: log, state: h, usage: newUsageStore(history, log),
		engine: engine.New(providers.All(c)...), drops: engine.New(providers.Drops(c)...), complete: c, home: home}
	l.engine.Panicked, l.drops.Panicked = l.panicked, l.panicked
	h.OnChange(func() { p.Main(l.stateChanged) })
	return l
}

func (l *Launcher) panicked(where string, v any) {
	l.log.Error("the launcher recovered from a panic", "where", where, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
}

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

func (l *Launcher) Visible() bool { return l.view != nil && l.view.Visible() }

func (l *Launcher) Show() {
	if l.view == nil {
		return
	}
	l.state.RefreshIfOlder(context.Background(), staleAfter)
	l.usage.load()
	if l.panel != nil {
		l.text = l.panel.saved
		l.panel = nil
	}
	l.view.Show(l.at)
	l.view.SetQuery(l.text, true)
	l.shownAt = time.Now()
	l.state.FollowProgress(true)
	l.peekClipboardAndRun()
}

func (l *Launcher) peekClipboardAndRun() {
	if l.p.ClipboardPeek == nil {
		l.run()
		return
	}
	l.seq++
	l.fresh, l.busy = false, true
	type peek struct {
		clip engine.Clip
		id   string
	}
	got := make(chan peek, 1)
	l.goSafe("clipboard peek", func() {
		var p peek
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
		l.dropped, l.text = nil, ""
	}
	l.acting = nil
	l.statusSeq++
	l.status = view.Status{}
	l.state.FollowProgress(false)
	l.view.Hide()
}

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

func (l *Launcher) run() { l.answer(false) }

func (l *Launcher) rerun() { l.answer(l.fresh) }

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

func (l *Launcher) LanguageChanged() {
	if !l.Visible() {
		return
	}
	if l.panel != nil {
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
	d := l.state.Data()
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

func (l *Launcher) answered(id uint64, q engine.Query, d *engine.Data, keep bool) func([]engine.Result, bool) {
	answered := false
	return func(rs []engine.Result, final bool) {
		l.p.Main(func() {
			if id != l.seq {
				return
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
				l.enter = false
				l.activate()
			}
		})
	}
}

func (l *Launcher) cur() (*cursor, int) {
	if l.panel != nil {
		return &l.panel.cursor, len(l.panel.actions)
	}
	return &l.cursor, len(l.results)
}

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
			l.dropped, l.text = nil, ""
			l.view.SetQuery("", false)
			l.run()
		default:
			l.Hide()
		}
	case view.KeyClose:
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
		if k.Char == view.StopAllChar {
			l.onStopAll()
			break
		}
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
	if l.staysOpen.Load() || !l.Visible() || time.Since(l.shownAt) < blurGrace {
		return
	}
	l.Hide()
}

func (l *Launcher) SetStaysOpen(stays bool) { l.staysOpen.Store(stays) }

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

func (l *Launcher) act(r engine.Result, a engine.Action, query string) {
	if a.Confirm != "" {
		l.ask(r, a, query)
		return
	}
	l.perform(r, a, query)
}

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
		l.clipUsed = l.clipID
	}
}

var errBroke = errs.New("something went wrong")

func (l *Launcher) runAction(a engine.Action, e *env) (err error) {
	defer func() {
		if v := recover(); v != nil {
			l.panicked("action "+a.ID, v)
			err = errBroke
		}
	}()
	return a.Run(context.Background(), e)
}

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

func inView(sel, off int, spans []float64) int {
	off = min(off, lastPage(spans), sel)
	for off < sel && wholeEnd(spans, off) <= sel {
		off++
	}
	return max(off, 0)
}

func drawnEnd(spans []float64, off int) int {
	end, h := off, 0.0
	for end < len(spans) && h < view.MaxListH {
		h += spans[end]
		end++
	}
	return end
}

func wholeEnd(spans []float64, off int) int {
	end, h := off, 0.0
	for end < len(spans) && h+spans[end] <= view.MaxListH {
		h += spans[end]
		end++
	}
	return end
}

func lastPage(spans []float64) int {
	i, h := len(spans), 0.0
	for i > 0 && h+spans[i-1] <= view.MaxListH {
		h += spans[i-1]
		i--
	}
	return i
}

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
