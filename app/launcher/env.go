package launcher

import (
	"context"
	"log/slog"
	"maps"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/core/i18n"
	launcherpb "github.com/rclone/rclone-ui/core/launcher"
	"github.com/rclone/rclone-ui/core/rclone"
)

// env is the environment that an action runs in. It gives the action access to the platform and
// the core.
type env struct {
	l      *Launcher
	action engine.Action
	// seq is the sequence number of the status that the action last showed in the corner (main
	// thread). When the action ends, it clears only that status.
	seq uint64
}

func (e *env) OpenWindow(name, url string) { e.l.p.OpenWindow(name, url) }
func (e *env) OpenFull(name, url string)   { e.l.p.OpenFull(name, url) }
func (e *env) Clipboard(text string)       { e.l.p.Clipboard(text) }
func (e *env) Reveal(path string)          { e.l.p.Reveal(path) }
func (e *env) OpenURL(url string)          { e.l.p.OpenURL(url) }
func (e *env) Notify(title, body string)   { e.l.p.Notify(title, body) }
func (e *env) Quit()                       { e.l.p.Quit() }
func (e *env) Core() engine.Services       { return e.l.state.Services() }

// Status shows a Stay action's progress or outcome in the status corner. It only does so if the
// corner is listening to this action, which means it is the last action run and the launcher
// hasn't closed since. Otherwise the status is dropped. Called off the main thread.
func (e *env) Status(kind engine.StatusKind, text string) {
	l := e.l
	l.p.MainSync(func() {
		if l.acting != e {
			return
		}
		k := view.StatusLoading
		if kind == engine.StatusDone {
			k = view.StatusDone
		}
		e.seq = l.setStatus(view.Status{Kind: k, Text: text})
	})
}

// finish ends the action. If the corner is listening to it, its progress message is cleared, or
// a failure is shown there in red. Otherwise a failure is only logged (the caller logs every
// failure). Called off the main thread.
func (e *env) finish(err error) {
	l := e.l
	l.p.MainSync(func() {
		if l.acting != e {
			return
		}
		l.acting = nil
		switch {
		case err != nil:
			// i18n: The launcher's status when an action failed. %[1]s is the action's name, such as "Unmount", and %[2]s the error.
			text := i18n.T("%[1]s failed: %[2]s", e.action.Name, rclone.ErrorOf(err).Localized().Message)
			l.setStatus(view.Status{Kind: view.StatusError, Text: text})
		case l.statusSeq == e.seq && l.status.Kind == view.StatusLoading:
			l.clearStatus()
		}
	})
}

// ClipboardText reads the clipboard after the user chose a result that needs it. Called off the
// main thread, like all actions.
func (e *env) ClipboardText() string {
	if e.l.p.ClipboardText == nil {
		return ""
	}
	return e.l.p.ClipboardText()
}

// SetQuery is used for drill-in actions. The launcher stays up and runs the query for the new
// text.
func (e *env) SetQuery(text string) {
	l := e.l
	l.p.Main(func() {
		l.panel = nil
		l.text = text
		if l.view != nil {
			if !l.view.Visible() {
				l.Show()
			}
			l.view.SetQuery(text, false)
		}
		l.run()
	})
}

// History is the launcher's usage history, which the core stores.
type History interface {
	Usage(ctx context.Context) ([]launcherpb.Usage, error)
	Record(ctx context.Context, key, query string) error
}

// usageStore caches the usage history that the core stores. It is read when the launcher shows,
// and written after each pick: the cache at once, then the core.
type usageStore struct {
	history History // nil when there is no history (in tests)
	log     *slog.Logger

	mu    sync.Mutex
	usage engine.Usage
}

func newUsageStore(history History, log *slog.Logger) *usageStore {
	return &usageStore{history: history, log: log, usage: engine.Usage{}}
}

// load reads the history again, in the background.
func (s *usageStore) load() {
	if s.history == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		usage, err := s.history.Usage(ctx)
		if err != nil {
			s.log.Debug("could not read the launcher's history", "error", err)
			return
		}
		u := engine.Usage{}
		for _, x := range usage {
			u[x.Key] = engine.Use{Count: int(x.Count), Last: time.UnixMilli(x.LastUsed), Queries: x.Queries}
		}
		s.mu.Lock()
		s.usage = u
		s.mu.Unlock()
	}()
}

func (s *usageStore) snapshot() engine.Usage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(engine.Usage, len(s.usage))
	maps.Copy(out, s.usage)
	return out
}

// record records that key was picked after typing query.
func (s *usageStore) record(key, query string) {
	s.mu.Lock()
	u := s.usage[key]
	u.Count++
	u.Last = time.Now()
	if query != "" {
		u.Queries = append([]string{query}, u.Queries...)
		if len(u.Queries) > 5 {
			u.Queries = u.Queries[:5]
		}
	}
	s.usage[key] = u
	s.mu.Unlock()
	if s.history == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.history.Record(ctx, key, query); err != nil {
		s.log.Debug("could not record a launcher pick", "error", err)
	}
}
