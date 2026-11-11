// Package syncx adds helpers that the sync package lacks.
package syncx

import (
	"context"
	"sync"
	"time"
)

// Wait waits for wg for at most d, and stops early if ctx ends. It reports whether wg finished.
// When it returns false, the goroutines that wg tracks keep running. Only the waiting stops.
func Wait(ctx context.Context, wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// Runner runs the core's background work on its own goroutines, with a context that ends when the
// core shuts down. *core.Core is one. Go runs a loop and starts it again after a panic. GoOnce runs
// one-shot work, which a panic ends for good, because running it twice would repeat it.
type Runner interface {
	Go(name string, fn func(ctx context.Context))
	GoOnce(name string, fn func(ctx context.Context))
}

// RunnerFunc is a Runner that runs both kinds of work with the same function. Tests use it.
type RunnerFunc func(name string, fn func(ctx context.Context))

func (f RunnerFunc) Go(name string, fn func(ctx context.Context)) { f(name, fn) }

func (f RunnerFunc) GoOnce(name string, fn func(ctx context.Context)) { f(name, fn) }
