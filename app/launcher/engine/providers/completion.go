package providers

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/match"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

var errNoCore = errs.New("the core is not ready")

// The completion's limits: how long it waits for typing to stop before listing, and the maximum
// number of entries it offers.
const (
	completionDelay = 120 * time.Millisecond
	completionMax   = 30
)

// Completion lists the folder of the path being typed and offers the entries whose names match
// the name being typed. Tab puts the selected one in the query. A folder's listing is streamed:
// its first page is offered at once, and the rest as they arrive. One listing per folder serves
// every query typed in that folder, so further typing lists the folder only once and doesn't
// restart a slow listing. Typing in another folder stops an unfinished listing. Listings are kept
// until Reset, which is called when the launcher hides.
type Completion struct {
	mu       sync.Mutex
	listings map[string]*listing
	ctx      context.Context // the parent context of the listings, cancelled by Reset
	cancel   context.CancelFunc
	delay    time.Duration
}

// listing holds one folder's entries as they arrive.
type listing struct {
	mu      sync.Mutex
	entries []engine.Entry
	done    bool
	update  chan struct{} // closed at each change, then replaced
	stop    context.CancelFunc
}

func NewCompletion() *Completion {
	c := &Completion{delay: completionDelay}
	c.Reset()
	return c
}

func (c *Completion) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.listings = map[string]*listing{}
}

func (c *Completion) Query(ctx context.Context, q engine.Query, d *engine.Data) []engine.Result {
	return c.QueryStream(ctx, q, d, func([]engine.Result) {})
}

// QueryStream offers the entries of the folder being typed in. Each time a page arrives, it passes
// the entries listed so far. ctx belongs to the query, so a newer query stops the waiting but not
// the listing.
func (c *Completion) QueryStream(ctx context.Context, q engine.Query, d *engine.Data, partial func([]engine.Result)) []engine.Result {
	if q.Typing == nil || d.List == nil {
		return nil
	}
	dir, prefix := split(q.Typing.Text)
	l := c.listing(dir)
	if l == nil {
		// a new folder is listed once typing in it pauses
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(c.delay):
		}
		l = c.start(dir, d.List)
	}
	for {
		l.mu.Lock()
		entries, done, update := l.entries, l.done, l.update
		l.mu.Unlock()
		rs := results(*q.Typing, d, dir, prefix, entries, q.Dropped)
		if done {
			return rs
		}
		if len(rs) > 0 {
			partial(rs)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-update:
		}
	}
}

func (c *Completion) listing(dir string) *listing {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.listings[dir]
}

// start lists dir, or joins a listing of dir that started in the meantime. It stops unfinished
// listings of other folders, because the user has moved on from them. A listing that fails is
// discarded, so the next query tries again.
func (c *Completion) start(dir string, list func(context.Context, string, func([]engine.Entry)) error) *listing {
	c.mu.Lock()
	defer c.mu.Unlock()
	if l := c.listings[dir]; l != nil {
		return l
	}
	for other, l := range c.listings {
		l.mu.Lock()
		unfinished := !l.done
		l.mu.Unlock()
		if unfinished {
			l.stop()
			delete(c.listings, other)
		}
	}
	ctx, stop := context.WithCancel(c.ctx)
	l := &listing{update: make(chan struct{}), stop: stop}
	c.listings[dir] = l
	go func() {
		err := list(ctx, dir, func(page []engine.Entry) { l.add(page, false) })
		if err != nil || ctx.Err() != nil {
			c.mu.Lock()
			if c.listings[dir] == l {
				delete(c.listings, dir)
			}
			c.mu.Unlock()
		}
		l.add(nil, true)
		stop()
	}()
	return l
}

// add appends a page, or marks the listing as ended when done is true. Either way it wakes the
// waiting queries.
func (l *listing) add(page []engine.Entry, done bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, page...)
	l.done = l.done || done
	close(l.update)
	l.update = make(chan struct{})
}

// results returns the entries of dir (in the path at) whose names match prefix, with folders
// first and at most completionMax of them. When files are dropped, only folders are returned, as
// places for the files to go.
func results(at engine.Path, d *engine.Data, dir, prefix string, entries []engine.Entry, dropped []engine.Path) []engine.Result {
	type scored struct {
		e     engine.Entry
		score int
		pos   []int
	}
	var picks []scored
	for _, e := range entries {
		if strings.HasPrefix(e.Name, ".") && !strings.HasPrefix(prefix, ".") || len(dropped) > 0 && !e.Dir {
			continue
		}
		m, ok := match.Match(prefix, e.Name)
		if !ok {
			continue
		}
		s := m.Score
		if e.Dir {
			s += 10 // folders first, since a typed path goes through them
		}
		picks = append(picks, scored{e, s, m.Positions})
	}
	sort.SliceStable(picks, func(i, j int) bool { return picks[i].score > picks[j].score })
	if len(picks) > completionMax {
		picks = picks[:completionMax]
	}
	out := make([]engine.Result, 0, len(picks))
	for i, p := range picks {
		full := dir + p.e.Name
		if len(dropped) > 0 {
			full += "/"
			out = append(out, engine.Result{
				ID: "complete:" + full, Key: historyKey("drop:path", full), Title: p.e.Name + "/",
				// i18n: Under a folder, as a place for what was dropped on the launcher. %s is a file's name, or "3 items".
				Subtitle: i18n.T("Copy %s here", droppedLabel(dropped)),
				Icon:     icons.Folder, Score: 120 + p.score - i, Always: true, Complete: full,
				Actions: []engine.Action{transferTo("copy", "Copy", dropped, full), transferTo("move", "Move", dropped, full)},
			})
			out[len(out)-1].SetMatch(p.pos)
			continue
		}
		icon := icons.File
		if p.e.Dir {
			full += "/"
			icon = icons.Folder
		}
		entry := engine.Path{Text: full, Local: at.Local, Remote: at.Remote, Features: at.Features}
		copyPath := copyText("copy-path", i18n.T("Copy Path"), full)
		// Enter browses a folder, or copies a file's path
		actions := append([]engine.Action{copyPath}, pathActions(entry, d, false)...)
		if p.e.Dir {
			actions = append(pathActions(entry, d, true), copyPath)
		}
		out = append(out, engine.Result{
			ID: "complete:" + full, Key: pathKey(full), Title: p.e.Name + dirSuffix(p.e.Dir), Subtitle: full, Icon: icon,
			Score: 120 + p.score - i, Always: true, Complete: full, Actions: actions, Group: engine.GroupFiles,
		})
		out[len(out)-1].SetMatch(p.pos)
	}
	return out
}

// split splits a typed path into its folder (with the separator) and the name being typed in it.
// "gdrive:Pho" → "gdrive:", "Pho"; "gdrive:a/b" → "gdrive:a/", "b"; "/tmp/x" → "/tmp/", "x".
func split(p string) (dir, name string) {
	i := strings.LastIndexAny(p, "/\\")
	if c := strings.Index(p, ":"); c > i && !(c == 1 && len(p) > 2) {
		i = c
	}
	if i < 0 {
		return p, ""
	}
	return p[:i+1], p[i+1:]
}

func dirSuffix(dir bool) string {
	if dir {
		return "/"
	}
	return ""
}

func named(a engine.Action, name string) engine.Action {
	a.Name = name
	return a
}
