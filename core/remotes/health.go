package remotes

import (
	"context"
	"sync"
	"time"

	"github.com/rclone/rclone/fs/cache"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

const (
	healthOKFor     = time.Hour        // how long an ok result stays valid
	healthFaultyFor = time.Minute      // a faulty remote is checked again soon
	healthTimeout   = 30 * time.Second // counted from when the check starts, not when it was queued
	healthAtOnce    = 3                // how many checks run at once, across the app
	// healthRetry is how long to wait before queuing a remote again after a check that got no
	// result (a timeout).
	healthRetry = time.Minute
)

type healthEntry struct {
	answer  *HealthResult // the last result rclone gave: ok or faulty
	at      time.Time     // when that result was given
	triedAt time.Time     // the time of the last check that got no result
}

// healthCache holds each remote's last result and runs the checks. Checks are queued by Health
// and by config changes. At most healthAtOnce run at a time, and at most one per remote.
type healthCache struct {
	s       *Service
	timeout time.Duration

	mu       sync.Mutex
	entries  map[string]*healthEntry
	pending  []string
	queued   map[string]bool
	inflight map[string]bool
	gen      map[string]int // incremented by forget, so the result of an earlier check is dropped
	workers  int
}

func newHealthCache(s *Service) *healthCache {
	return &healthCache{
		s: s, timeout: healthTimeout,
		entries: map[string]*healthEntry{}, queued: map[string]bool{},
		inflight: map[string]bool{}, gen: map[string]int{},
	}
}

// Health returns every remote's cached result, or checking where there is none or it is stale.
// It also queues the checks that are due. It never waits for a check. Instead, each finished
// check publishes remotes.health with the remote as id, and its state and error.
func (s *Service) Health(ctx context.Context) map[string]HealthResult {
	return s.health.read(s.names())
}

// Recheck drops every remote's result and queues a check for each one, for the Remotes page's
// refresh. Health reports checking until each check finishes and publishes its result, which is
// unknown for a check that got no result.
func (s *Service) Recheck() { s.health.forget(s.names()) }

// CheckRemote drops one remote's result and queues a check of it, for its edit form.
func (s *Service) CheckRemote(name string) { s.health.forget([]string{name}) }

func (h *healthCache) read(names []string) map[string]HealthResult {
	now := h.s.now()
	out := make(map[string]HealthResult, len(names))
	var due []string
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, n := range names {
		e := h.entries[n]
		queued, inflight := h.queued[n], h.inflight[n]
		triedLately := e != nil && now.Sub(e.triedAt) < healthRetry
		// The last check got no result and no new check has been queued since. Its call may
		// still be running, for a backend that ignores its context, but a page shouldn't wait
		// for it.
		lost := e != nil && e.triedAt.After(e.at) && !queued
		switch {
		case e != nil && e.answer != nil && fresh(e, now):
			out[n] = *e.answer
		case lost && (triedLately || inflight):
			out[n] = h.noAnswerLocked(e)
		default:
			out[n] = HealthResult{State: HealthChecking}
			if !queued && !inflight && !triedLately {
				due = append(due, n)
			}
		}
	}
	h.enqueueLocked(due)
	return out
}

// noAnswerLocked returns what the pages see after a check that got no result: the previous
// result, or unknown when there was none. This way a page that waits for every remote's result
// isn't stuck on a remote that never responds.
func (h *healthCache) noAnswerLocked(e *healthEntry) HealthResult {
	if e.answer != nil {
		return *e.answer
	}
	return HealthResult{State: HealthUnknown, problem: errs.Errorf("Rclone did not answer within %s.", h.timeout)}
}

func fresh(e *healthEntry, now time.Time) bool {
	keep := healthFaultyFor
	if e.answer.State == HealthOK {
		keep = healthOKFor
	}
	return now.Sub(e.at) < keep
}

// forget drops the results for names, after a reconnect or a config change, and queues a check
// for each name that is still a remote.
func (h *healthCache) forget(names []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var again []string
	for _, n := range names {
		delete(h.entries, n)
		h.gen[n]++
		if h.s.exists(n) {
			again = append(again, n)
		}
	}
	h.enqueueLocked(again)
}

func (h *healthCache) enqueueLocked(names []string) {
	for _, n := range names {
		if !h.queued[n] {
			h.queued[n] = true
			h.pending = append(h.pending, n)
		}
	}
	for h.workers < healthAtOnce && h.workers < len(h.pending) {
		h.workers++
		h.s.run.Go("remotes-health", h.work)
	}
}

// next takes the first queued remote that has no check running.
func (h *healthCache) next() (name string, gen int, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, n := range h.pending {
		if h.inflight[n] {
			continue
		}
		h.pending = append(h.pending[:i:i], h.pending[i+1:]...)
		delete(h.queued, n)
		h.inflight[n] = true
		return n, h.gen[n], true
	}
	h.workers--
	return "", 0, false
}

// work runs checks until none is due. If it is restarted after a panic, it carries on.
func (h *healthCache) work(ctx context.Context) {
	for ctx.Err() == nil {
		name, gen, ok := h.next()
		if !ok {
			return
		}
		h.check(ctx, name, gen)
	}
	h.mu.Lock()
	h.workers--
	h.mu.Unlock()
}

// check checks one remote. At the timeout, the worker slot is freed at once. The remote stays
// marked as running until rclone returns (for a backend that ignores its context), so a second
// check of it never runs at the same time.
func (h *healthCache) check(ctx context.Context, name string, gen int) {
	if !h.s.exists(name) {
		h.done(name)
		return
	}
	cctx, cancel := context.WithTimeout(ctx, h.timeout)
	type result struct {
		health   HealthResult
		answered bool
	}
	res := make(chan result, 1)
	go func() {
		defer h.done(name)
		health, answered := ask(cctx, name)
		res <- result{health, answered}
	}()
	var r result
	select {
	case r = <-res:
	case <-cctx.Done():
	}
	cancel()

	h.mu.Lock()
	if h.gen[name] != gen {
		// The config changed during the check, and a new check is queued.
		h.mu.Unlock()
		return
	}
	e := h.entries[name]
	if e == nil {
		e = &healthEntry{}
		h.entries[name] = e
	}
	shown := r.health
	if r.answered {
		e.answer, e.at = &r.health, h.s.now()
	} else {
		// No result says nothing about the remote. Pages that show checking get the last
		// result, or unknown.
		e.triedAt = h.s.now()
		shown = h.noAnswerLocked(e)
	}
	h.mu.Unlock()
	h.s.bus.Publish(bus.RemotesHealth, bus.RemotesHealthData{ID: name, State: shown.State, Error: shown.shown().Error})
}

// done marks name's check as over, so a check of it that was queued in the meantime can run.
// The workers skipped that check while the first one was running, and they may all have exited
// since, so a worker is started again for it.
func (h *healthCache) done(name string) {
	h.mu.Lock()
	delete(h.inflight, name)
	if len(h.pending) > 0 {
		h.enqueueLocked(nil)
	}
	h.mu.Unlock()
}

// ask opens the remote and then lists its root. The listing is needed because an alias to a
// missing folder opens without error. answered is false when there is no result, because of the
// timeout or the app shutting down, which says nothing about the remote. Any error that rclone
// returns counts as a result.
func ask(ctx context.Context, name string) (health HealthResult, answered bool) {
	group := rclone.UIGroup("health", name)
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	faulty := func(err, shown error) (HealthResult, bool) {
		if ctx.Err() != nil {
			return HealthResult{}, false
		}
		return HealthResult{
			State:   HealthFaulty,
			problem: shown,
			// Only advice for this remote counts, because a wrapper over it fails with the same
			// text.
			CanReconnect: rclone.HasReconnectAdvice(err, name),
		}, true
	}
	var listErr error
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, name+":")
		if err != nil {
			return err
		}
		if listErr = rclone.FirstPage(ctx, f, ""); listErr != nil {
			return nil
		}
		health = HealthResult{State: HealthOK}
		if about := f.Features().About; about != nil {
			// The quota is extra information on the card, and a remote that doesn't report it
			// still works.
			if u, err := about(ctx); err == nil {
				health.About = u
			}
		}
		return nil
	})
	switch {
	case err != nil:
		return faulty(err, rclone.ErrorOf(err))
	case listErr != nil:
		// i18n: The value is why the remote's top folder couldn't be listed.
		return faulty(listErr, errs.Errorf("Cannot list: %s", rclone.ErrorOf(listErr)))
	}
	return health, true
}
