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

type env struct {
	l      *Launcher
	action engine.Action
	seq    uint64
}

func (e *env) OpenWindow(name, url string) { e.l.p.OpenWindow(name, url) }
func (e *env) OpenFull(name, url string)   { e.l.p.OpenFull(name, url) }
func (e *env) Clipboard(text string)       { e.l.p.Clipboard(text) }
func (e *env) Reveal(path string)          { e.l.p.Reveal(path) }
func (e *env) OpenURL(url string)          { e.l.p.OpenURL(url) }
func (e *env) Notify(title, body string)   { e.l.p.Notify(title, body) }
func (e *env) Quit()                       { e.l.p.Quit() }
func (e *env) Core() engine.Services       { return e.l.state.Services() }

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

func (e *env) ClipboardText() string {
	if e.l.p.ClipboardText == nil {
		return ""
	}
	return e.l.p.ClipboardText()
}

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

type History interface {
	Usage(ctx context.Context) ([]launcherpb.Usage, error)
	Record(ctx context.Context, key, query string) error
}

type usageStore struct {
	history History
	log     *slog.Logger

	mu    sync.Mutex
	usage engine.Usage
}

func newUsageStore(history History, log *slog.Logger) *usageStore {
	return &usageStore{history: history, log: log, usage: engine.Usage{}}
}

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
