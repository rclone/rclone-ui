package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/rclone/rclone/lib/atexit"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/tunnel"
)

const (
	// stopTimeout is the time limit for stopping all the services together. Each service sets
	// its own shorter limits within it.
	stopTimeout = 30 * time.Second
	// goesWait is how long the shutdown waits for the goroutines started with Go to end.
	goesWait = 5 * time.Second
)

// Shutdown stops the core. Only the first call does anything. It stops the services in the order
// of stopSteps, then the core's goroutines, the database and the lock on the data folder. rclone's
// own exit functions run last. restart is true for an update's planned restart, in which case what
// is running is recorded so it can start again. Both ctx and stopTimeout limit how long the stops
// take.
func (c *Core) Shutdown(ctx context.Context, restart bool) {
	c.down.Do(func() {
		c.mu.Lock()
		c.stopping = true
		c.mu.Unlock()

		log := logs.Logger(logs.CompApp, logs.SubShutdown)
		ctx, cancel := context.WithTimeout(ctx, stopTimeout)
		defer cancel()
		log.InfoContext(ctx, "stopping", "restart", restart)
		if c.built {
			c.stopServices(ctx, restart)
			// Sends what is waiting, for a moment at most.
			c.telemetry.Close()
		}

		c.cancel()
		// This wait has its own limit, however much of ctx the stops used.
		if !syncx.Wait(context.Background(), &c.goes, goesWait) {
			log.WarnContext(ctx, "some of the core's goroutines had not ended", "waited", goesWait)
		}
		if c.db != nil {
			if err := c.db.Close(); err != nil {
				log.Error("closing the database", "error", err)
			}
		}
		if c.runDir != "" {
			_ = os.Remove(filepath.Join(c.runDir, runningFile))
		}
		if c.logs != nil && c.logs != c.opts.Log {
			_ = c.logs.Close()
		}
		if c.release != nil {
			c.release()
		}
		atexit.Run()
	})
}

// stopServices stops the services that have a lifetime, in the order of stopSteps. Each stop is
// safe when the boot failed before starting that service. The supervisor, for one, leaves
// children.json alone until it has begun, so the next start still finds what the previous run
// left.
func (c *Core) stopServices(ctx context.Context, restart bool) {
	for _, st := range c.stopSteps() {
		if st.shutdown != nil {
			st.shutdown(ctx, restart)
		}
	}
}

// StopAll is the launcher's Stop Everything. It stops what the core runs: the transfers (a
// watcher's or a schedule's run included), the serves, the mounts and the remote tunnel, which is
// the set that Busy lists for the quit dialog. The watchers and schedules stay on, because they
// are settings rather than things that run. StopAll goes on after an error, and returns what it
// stopped along with the errors joined.
func (c *Core) StopAll(ctx context.Context) (StopSummary, error) {
	var sum StopSummary
	var errs []error
	for _, st := range c.stopSteps() {
		if st.stopAll == nil {
			continue
		}
		if err := st.stopAll(ctx, &sum.Running); err != nil {
			errs = append(errs, err)
		}
	}
	return sum, errors.Join(errs...)
}

// stopStep is one step of stopping the core, in the list that both Shutdown and StopAll follow.
type stopStep struct {
	// shutdown is the step's part of Shutdown, or nil when it has none.
	shutdown func(ctx context.Context, restart bool)
	// stopAll is the step's part of StopAll, and records in stopped how much it stopped. It is
	// nil for what StopAll leaves alone.
	stopAll func(ctx context.Context, stopped *Running) error
}

func (c *Core) stopSteps() []stopStep {
	return []stopStep{
		// The media URLs stop first in a shutdown, which ends the previews' reads. StopAll leaves
		// them, because they run nothing that the user started.
		{shutdown: func(ctx context.Context, _ bool) { c.media.Shutdown(ctx) }},
		// The tunnel stops before the children, because its own stop in a shutdown records it so
		// it can start again after an update's restart.
		{shutdown: c.tunnel.Shutdown, stopAll: c.stopTunnel},
		// In a shutdown, the watchers and schedules start no run after this. StopAll leaves them
		// on. Their runs in progress are transfers, which stop next.
		{shutdown: func(context.Context, bool) {
			c.watchers.Shutdown()
			c.schedules.Shutdown()
		}},
		// The transfers stop before the serves and mounts, because a transfer that reads from a
		// mount would fail when the mount goes.
		{shutdown: c.transfers.Shutdown, stopAll: func(ctx context.Context, stopped *Running) error {
			n, err := c.transfers.StopAll(ctx)
			stopped.Transfers = n
			return err
		}},
		{stopAll: func(ctx context.Context, stopped *Running) error {
			n, err := c.serves.StopAll(ctx)
			stopped.Serves = n
			return err
		}},
		{stopAll: func(ctx context.Context, stopped *Running) error {
			n, err := c.mounts.StopAll(ctx)
			stopped.Mounts = n
			return err
		}},
		// A shutdown stops the serves and the mounts together through the supervisor, which can
		// keep their records for an update's restart.
		{shutdown: c.stopChildren},
	}
}

func (c *Core) stopTunnel(ctx context.Context, stopped *Running) error {
	if c.tunnel.Status().State == tunnel.StateOff {
		return nil
	}
	if err := c.tunnel.Stop(ctx); err != nil {
		return err
	}
	stopped.Tunnel = true
	return nil
}

// Go runs fn, a loop that the core needs, on its own goroutine for as long as the core runs (ctx
// ends at shutdown). If fn panics, the panic is recovered and logged with its stack, and fn is
// started again after a backoff. When fn returns, it is not started again. Use GoOnce for one-shot
// work.
func (c *Core) Go(name string, fn func(ctx context.Context)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopping {
		return
	}
	backoff := c.backoff
	if backoff == (children.Backoff{}) {
		backoff = children.RcloneBackoff
	}
	c.goes.Go(func() {
		retry := backoff.Retry()
		for {
			began := time.Now()
			if !c.runRecovered(name, fn) || c.ctx.Err() != nil {
				return
			}
			delay, _ := retry.Next(time.Since(began))
			logs.Logger(logs.CompApp, "").WarnContext(c.ctx, "starting a goroutine again after its panic",
				"goroutine", name, "in", delay)
			select {
			case <-c.ctx.Done():
				return
			case <-time.After(delay):
			}
		}
	})
}

// GoOnce runs fn once on its own goroutine, with a context that ends when the core shuts down. If
// fn panics, the panic is recovered, logged with its stack and reported. fn is not started again,
// because running one-shot work twice (such as a boot that starts the mounts) would repeat it.
func (c *Core) GoOnce(name string, fn func(ctx context.Context)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopping {
		return
	}
	c.goes.Go(func() { c.runRecovered(name, fn) })
}

func (c *Core) runRecovered(name string, fn func(ctx context.Context)) (panicked bool) {
	defer func() {
		if v := recover(); v != nil {
			panicked = true
			logs.Logger(logs.CompApp, "").ErrorContext(c.ctx, "a goroutine panicked",
				"goroutine", name, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
		}
	}()
	fn(c.ctx)
	return false
}
