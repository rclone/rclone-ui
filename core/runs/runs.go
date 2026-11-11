// Package runs is the run engine that the watchers and the schedules share. Each of them has
// items (a watcher, a schedule) that run as transfers, one run at a time per item. The engine
// claims a run before it starts, so the runs of an item never overlap, and frees the claim once
// the run's end is recorded. It starts the run through its owner (Owner), which builds the
// transfer and records how the run ended. It also queues a run asked for during another, frees a
// run whose end was never reported (FreeStale), stops a run whose item was deleted, and refuses
// new runs after Shutdown.
package runs

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/transfers"
)

// Transfers starts, stops and checks transfers. It is *transfers.Service.
type Transfers interface {
	Start(ctx context.Context, spec transfers.Spec) (transfers.Started, error)
	Stop(ctx context.Context, id string) error
	// Open reports whether a transfer is still queued or running.
	Open(ctx context.Context, id string) (bool, error)
}

// Run is one run of an item, from its claim until its end is recorded. Mode is why it runs, and
// Data is what the owner keeps about it, which the owner fills in as it starts the run.
type Run[M comparable, D any] struct {
	Mode M
	Data D

	// The fields below are guarded by Engine.mu.

	// transfer is the run's transfer, once its start has returned, unless the run had already
	// ended by then.
	transfer string
	// ended is set when the run's end is being recorded. From then on, nothing frees the run but
	// its end.
	ended bool
	// closedSeen is set when a tick found the run's transfer closed while its end wasn't reported
	// yet (see FreeStale).
	closedSeen bool
	// gone is set when the run's item was deleted and its run must stop. A run whose start hasn't
	// returned yet is stopped as soon as it has a transfer.
	gone bool
}

// Owner is the watchers' or the schedules' side of the engine. The engine calls it from its own
// goroutines, never while it holds a lock, except for Started.
type Owner[M comparable, D any] interface {
	// Start starts r, a run of the item id, through the transfer service, with end as the
	// transfer's owner. It reports false when it didn't start the run, because the item is gone
	// or the run doesn't apply any more (a paused item, say), after it recorded what it needed.
	// Otherwise it returns what the transfer service returned.
	Start(ctx context.Context, id string, r *Run[M, D], end transfers.Owner) (transfers.Started, bool, error)
	// Started is called once r has a transfer, while r is still the item's run and its end
	// hasn't begun to be recorded. It runs under the engine's lock, so that the end waits for
	// it: it must not call the engine.
	Started(ctx context.Context, id string, r *Run[M, D], transfer string)
	// Refused records that the transfer service refused r before it recorded anything, as a
	// failed run.
	Refused(ctx context.Context, id string, r *Run[M, D], err error)
	// Quiet reports whether r's transfer, which ended so, did nothing worth keeping in History
	// (transfers.Owner).
	Quiet(r *Run[M, D], st transfers.State, errText string, s *transfers.Summary) bool
	// Ended records how r ended, from its transfer t. When again is set, a run in mode next
	// starts once r is freed, unless another run was queued meanwhile.
	Ended(ctx context.Context, id string, r *Run[M, D], t transfers.Transfer) (next M, again bool)
	// Changed tells the pages that the items changed: a run was freed, or a queued run claimed.
	Changed()
}

// Options configure an engine.
type Options struct {
	// Name names the engine's goroutines ("watchers", "schedules").
	Name      string
	Transfers Transfers
	// Runner runs each run's start on its own goroutine, with a context that ends when the core
	// shuts down. It is the core itself.
	Runner syncx.Runner
	Log    *slog.Logger
}

// Engine runs the items of one owner.
type Engine[M comparable, D any] struct {
	o     Options
	owner Owner[M, D]

	mu sync.Mutex
	// runs holds the run in progress of each item, from its claim until its end is recorded.
	runs map[string]*Run[M, D]
	// queued holds a run asked for while the item's run was in progress. It starts when that run
	// is freed.
	queued   map[string]M
	stopping bool
}

// New returns an engine whose runs owner starts and records.
func New[M comparable, D any](o Options, owner Owner[M, D]) *Engine[M, D] {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Engine[M, D]{o: o, owner: owner, runs: map[string]*Run[M, D]{}, queued: map[string]M{}}
}

// Claim claims a run of the item id in mode m, which the caller then starts with Start. It
// reports false, and claims nothing, while the item has a run in progress or after Shutdown.
func (e *Engine[M, D]) Claim(id string, m M) (*Run[M, D], bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.claimLocked(id, m)
}

func (e *Engine[M, D]) claimLocked(id string, m M) (*Run[M, D], bool) {
	if e.stopping || e.runs[id] != nil {
		return nil, false
	}
	r := &Run[M, D]{Mode: m}
	e.runs[id] = r
	return r, true
}

// Kick claims a run of the item id in mode m and starts it on its own goroutine. It reports
// false, and starts nothing, while the item has a run in progress or after Shutdown.
func (e *Engine[M, D]) Kick(id string, m M) bool {
	r, ok := e.Claim(id, m)
	if ok {
		e.goStart(id, r)
	}
	return ok
}

// Queue starts a run of the item id in mode m, like Kick. While the item has a run in progress,
// the run waits instead, and starts once that run is freed. A later Queue replaces the run that
// waits.
func (e *Engine[M, D]) Queue(id string, m M) {
	e.mu.Lock()
	if e.stopping {
		e.mu.Unlock()
		return
	}
	if e.runs[id] != nil {
		e.queued[id] = m
		e.mu.Unlock()
		return
	}
	r, _ := e.claimLocked(id, m)
	e.mu.Unlock()
	e.goStart(id, r)
}

func (e *Engine[M, D]) goStart(id string, r *Run[M, D]) {
	e.o.Runner.GoOnce(e.o.Name+".run", func(ctx context.Context) { e.Start(ctx, id, r) })
}

// Start starts r, a claimed run of the item id, through the owner, and waits for the transfer
// service's answer. A run that doesn't start is freed. A run that the transfer service refused
// before it recorded anything ends as a failure (Owner.Refused). A run whose item was deleted
// meanwhile is stopped.
func (e *Engine[M, D]) Start(ctx context.Context, id string, r *Run[M, D]) {
	e.mu.Lock()
	stopping := e.stopping
	e.mu.Unlock()
	if stopping || ctx.Err() != nil {
		e.release(id, r)
		return
	}
	started, ok, err := e.owner.Start(ctx, id, r, end[M, D]{e, id, r})
	switch {
	case !ok:
		e.release(id, r)
		return
	case err != nil && started.ID == "" && errors.Is(err, transfers.ErrShuttingDown):
		e.release(id, r)
		return
	case err != nil && started.ID == "":
		e.refused(ctx, id, r, err)
		return
	}
	// A transfer that failed at once may have reported its end already. That end frees the run,
	// so the transfer is only recorded on a run that is still waiting for its end.
	e.mu.Lock()
	gone := r.gone
	if !r.ended && e.runs[id] == r {
		r.transfer = started.ID
		e.owner.Started(ctx, id, r, started.ID)
	}
	e.mu.Unlock()
	if gone && started.ID != "" {
		e.stop(ctx, started.ID)
	}
}

// refused ends r, which the transfer service refused before it recorded anything.
func (e *Engine[M, D]) refused(ctx context.Context, id string, r *Run[M, D], err error) {
	e.mu.Lock()
	r.ended = true
	e.mu.Unlock()
	e.owner.Refused(ctx, id, r, err)
	e.release(id, r)
}

// ended ends r from its transfer t. The run stays the item's run until the owner has recorded
// its end, so that a run started in between doesn't read the item as it was before this end.
func (e *Engine[M, D]) ended(id string, r *Run[M, D], t transfers.Transfer) {
	e.mu.Lock()
	r.ended = true
	e.mu.Unlock()
	next, again := e.owner.Ended(context.Background(), id, r, t)
	e.free(id, r, next, again)
}

// release frees r, a run that didn't start, or whose end was recorded without a transfer.
func (e *Engine[M, D]) release(id string, r *Run[M, D]) {
	var none M
	e.free(id, r, none, false)
}

// free forgets r when it is still the item's run, and starts the run that follows it (see
// freeLocked).
func (e *Engine[M, D]) free(id string, r *Run[M, D], next M, again bool) {
	e.mu.Lock()
	claimed := e.freeLocked(id, r, next, again)
	e.mu.Unlock()
	e.owner.Changed()
	if claimed != nil {
		e.goStart(id, claimed)
	}
}

// freeLocked forgets r when it is still the item's run, and claims the run that follows it: the
// one queued during r, or else, with again, a run in mode next. The caller holds e.mu, and starts
// the claimed run once it has let go of it.
func (e *Engine[M, D]) freeLocked(id string, r *Run[M, D], next M, again bool) *Run[M, D] {
	if e.runs[id] == r {
		delete(e.runs, id)
		if q, ok := e.queued[id]; ok {
			next, again = q, true
			delete(e.queued, id)
		}
	}
	if !again {
		return nil
	}
	claimed, _ := e.claimLocked(id, next)
	return claimed
}

// FreeStale frees each run whose transfer is no longer open in the transfer service, although
// its end was never reported. Without it, the item would never run again. The transfer service
// writes a transfer's end before it reports it, so a tick can find the transfer closed just
// before its end arrives. A run is therefore freed only when two ticks in a row find its
// transfer closed, and never once its end is being recorded. Freed any earlier, the next run
// would start before the owner has recorded how this one ended.
func (e *Engine[M, D]) FreeStale(ctx context.Context) {
	type held struct {
		id, transfer string
		r            *Run[M, D]
	}
	var all []held
	e.mu.Lock()
	for id, r := range e.runs {
		if r.transfer != "" && !r.ended {
			all = append(all, held{id, r.transfer, r})
		}
	}
	e.mu.Unlock()
	for _, h := range all {
		open, err := e.o.Transfers.Open(ctx, h.transfer)
		if err != nil || open {
			continue
		}
		e.mu.Lock()
		first := !h.r.closedSeen
		h.r.closedSeen = true
		stale := !first && !h.r.ended && e.runs[h.id] == h.r
		var claimed *Run[M, D]
		if stale {
			var none M
			claimed = e.freeLocked(h.id, h.r, none, false)
		}
		e.mu.Unlock()
		if !stale {
			continue
		}
		e.o.Log.WarnContext(ctx, "freeing a run whose end was never reported", "item", h.id, "transfer", h.transfer)
		e.owner.Changed()
		if claimed != nil {
			e.goStart(h.id, claimed)
		}
	}
}

// Status is a run in progress, as Current returns it.
type Status[M comparable] struct {
	Mode M
	// Transfer is the run's transfer, or "" until its start returns.
	Transfer string
	// Next is the run queued during it, when Queued is set.
	Next   M
	Queued bool
}

// Current returns the run in progress of each item that has one.
func (e *Engine[M, D]) Current() map[string]Status[M] {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]Status[M], len(e.runs))
	for id, r := range e.runs {
		next, queued := e.queued[id]
		out[id] = Status[M]{Mode: r.Mode, Transfer: r.transfer, Next: next, Queued: queued}
	}
	return out
}

// Forget forgets the item id, which was deleted, with its run in progress and the run queued
// during it. With stop, that run is stopped, at once or as soon as its start returns. Without,
// it goes on, and its end is still given to the owner.
func (e *Engine[M, D]) Forget(ctx context.Context, id string, stop bool) {
	e.mu.Lock()
	r := e.runs[id]
	delete(e.runs, id)
	delete(e.queued, id)
	var transfer string
	if r != nil && stop {
		r.gone = true
		transfer = r.transfer
	}
	e.mu.Unlock()
	if transfer != "" {
		e.stop(ctx, transfer)
	}
}

// stop stops a run's transfer. A transfer that has just ended is not an error.
func (e *Engine[M, D]) stop(ctx context.Context, transfer string) {
	if err := e.o.Transfers.Stop(ctx, transfer); err != nil && !errors.Is(err, transfers.ErrNotRunning) {
		e.o.Log.WarnContext(ctx, "stopping a run", "transfer", transfer, "error", err)
	}
}

// Shutdown stops the engine from claiming runs. The runs in progress are the transfer service's,
// which stops them. Their ends are still given to the owner.
func (e *Engine[M, D]) Shutdown() {
	e.mu.Lock()
	e.stopping = true
	e.mu.Unlock()
}

// end is the owner of a run's transfer (transfers.Owner).
type end[M comparable, D any] struct {
	e  *Engine[M, D]
	id string
	r  *Run[M, D]
}

func (x end[M, D]) Quiet(st transfers.State, errText string, s *transfers.Summary) bool {
	return x.e.owner.Quiet(x.r, st, errText, s)
}

func (x end[M, D]) Ended(t transfers.Transfer) { x.e.ended(x.id, x.r, t) }
