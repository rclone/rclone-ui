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
	healthOKFor     = time.Hour
	healthFaultyFor = time.Minute
	healthTimeout   = 30 * time.Second
	healthAtOnce    = 3
	healthRetry     = time.Minute
)

type healthEntry struct {
	answer  *HealthResult
	at      time.Time
	triedAt time.Time
}

type healthCache struct {
	s       *Service
	timeout time.Duration

	mu       sync.Mutex
	entries  map[string]*healthEntry
	pending  []string
	queued   map[string]bool
	inflight map[string]bool
	gen      map[string]int
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

// Recheck drops every remote's result and queues a check for each one. Health reports checking
// until each check finishes and publishes its result, which is unknown for a check that got no
// result.
func (s *Service) Recheck() { s.health.forget(s.names()) }

// CheckRemote drops one remote's result and queues a check of it.
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
		e.triedAt = h.s.now()
		shown = h.noAnswerLocked(e)
	}
	h.mu.Unlock()
	h.s.bus.Publish(bus.RemotesHealth, bus.RemotesHealthData{ID: name, State: shown.State, Error: shown.shown().Error})
}

func (h *healthCache) done(name string) {
	h.mu.Lock()
	delete(h.inflight, name)
	if len(h.pending) > 0 {
		h.enqueueLocked(nil)
	}
	h.mu.Unlock()
}

// ask opens the remote and then lists its root. The listing is needed because an alias to a
// missing folder opens without error.
func ask(ctx context.Context, name string) (health HealthResult, answered bool) {
	group := rclone.UIGroup("health", name)
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	faulty := func(err, shown error) (HealthResult, bool) {
		if ctx.Err() != nil {
			return HealthResult{}, false
		}
		return HealthResult{
			State:        HealthFaulty,
			problem:      shown,
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
