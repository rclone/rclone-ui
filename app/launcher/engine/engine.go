package engine

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// The timing of a query's snapshots. The first is sent once the quick providers have answered (or
// after firstFlush). After that, at most one is sent every flushEvery while slow providers
// (listings) are still working.
const (
	firstFlush = 16 * time.Millisecond
	flushEvery = 32 * time.Millisecond
)

type Engine struct {
	providers []Provider
	// Panicked is called when a provider panics. The panic is recovered either way: that provider
	// returns no results, and the query continues with the others. Panicked runs on the provider's
	// goroutine before the stack unwinds, so it can record the panic's stack trace. It may be nil.
	Panicked func(where string, v any)
}

func New(providers ...Provider) *Engine {
	return &Engine{providers: providers}
}

// Run runs q. emit receives the full ranked list each time, and final is true on the last call.
// Cancelling ctx (for a newer query) stops Run, and emit is not called after that.
func (e *Engine) Run(ctx context.Context, q Query, d *Data, usage Usage, emit func(results []Result, final bool)) {
	var (
		mu sync.Mutex
		// Each provider's results go in their own slot, so ties rank in the order the providers are
		// listed, not in the order they answer.
		found     = make([][]Result, len(e.providers))
		pending   = len(e.providers)
		quickLeft = 0
		changed   = make(chan struct{}, 1)
		quickDone = make(chan struct{})
	)
	for _, p := range e.providers {
		if _, slow := p.(Streamer); !slow {
			quickLeft++
		}
	}
	if quickLeft == 0 {
		close(quickDone)
	}
	signal := func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	for i, p := range e.providers {
		go func(i int, p Provider) {
			var rs []Result
			s, slow := p.(Streamer)
			defer func() {
				if v := recover(); v != nil {
					rs = nil
					if e.Panicked != nil {
						e.Panicked(fmt.Sprintf("provider %T", p), v)
					}
				}
				mu.Lock()
				found[i] = rs
				pending--
				if !slow {
					if quickLeft--; quickLeft == 0 {
						close(quickDone)
					}
				}
				mu.Unlock()
				signal()
			}()
			if slow {
				rs = s.QueryStream(ctx, q, d, func(part []Result) {
					mu.Lock()
					found[i] = part
					mu.Unlock()
					signal()
				})
			} else {
				rs = p.Query(ctx, q, d)
			}
		}(i, p)
	}
	snapshot := func() ([]Result, bool) {
		mu.Lock()
		defer mu.Unlock()
		var all []Result
		for _, rs := range found {
			all = append(all, rs...)
		}
		return Rank(q, all, usage, time.Now()), pending == 0
	}
	select {
	case <-ctx.Done():
		return
	case <-quickDone:
	case <-time.After(firstFlush):
	}
	rs, final := snapshot()
	if ctx.Err() != nil {
		return
	}
	emit(rs, final)
	for !final {
		select {
		case <-ctx.Done():
			return
		case <-changed:
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(flushEvery):
		}
		rs, final = snapshot()
		if ctx.Err() != nil {
			return
		}
		emit(rs, final)
	}
}
