package remotes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/rclone"
)

const (
	// fsinfoMaxAge is how long a remote's cached fsinfo stays valid.
	fsinfoMaxAge = 24 * time.Hour
	// fsinfoRetry is how long to wait before trying again for a remote whose fsinfo couldn't be
	// read, instead of trying on every page render.
	fsinfoRetry = time.Minute
	// fsinfoTimeout limits one refresh, as for a health check.
	fsinfoTimeout = 30 * time.Second
	// fsinfoPublishEvery combines remotes.changed events while a batch of refreshes runs.
	fsinfoPublishEvery = 2 * time.Second
)

// fsinfoCache refreshes remote_fsinfo.fsinfo in the background, one remote at a time, and
// publishes remotes.changed when refreshed entries are stored.
type fsinfoCache struct {
	s *Service

	mu      sync.Mutex
	pending []string
	queued  map[string]bool
	failed  map[string]time.Time // the time of the last failed refresh
	running bool
	gen     map[string]int // incremented by forget, so a refresh started earlier isn't stored
}

func newFSInfoCache(s *Service) *fsinfoCache {
	return &fsinfoCache{s: s, queued: map[string]bool{}, failed: map[string]time.Time{}, gen: map[string]int{}}
}

// queue requests a refresh for names, skipping those already queued or that failed recently.
func (c *fsinfoCache) queue(names []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.s.now()
	added := false
	for _, n := range names {
		if c.queued[n] {
			continue
		}
		if at, ok := c.failed[n]; ok && now.Sub(at) < fsinfoRetry {
			continue
		}
		c.queued[n] = true
		c.pending = append(c.pending, n)
		added = true
	}
	if added && !c.running {
		c.running = true
		c.s.run.Go("remotes-fsinfo", c.work)
	}
}

// forget drops what is known about the fsinfo of names. The change handling clears the rows. A
// refresh that is running won't be stored, and an earlier failure won't delay the next one.
func (c *fsinfoCache) forget(names []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range names {
		c.gen[n]++
		delete(c.failed, n)
	}
}

// work processes the queue until it is empty. If it is restarted after a panic, it carries on
// where it stopped.
func (c *fsinfoCache) work(ctx context.Context) {
	var unpublished bool
	var last time.Time
	for {
		c.mu.Lock()
		if len(c.pending) == 0 || ctx.Err() != nil {
			c.running = false
			c.mu.Unlock()
			break
		}
		name := c.pending[0]
		c.pending = c.pending[1:]
		gen := c.gen[name]
		c.mu.Unlock()

		stored, stale := c.refresh(ctx, name, gen)
		if stale {
			// The result was for the old config. Any refresh requested since then (the pages list
			// the remotes again after the change) was skipped because this one was queued, so
			// queue it again.
			c.queue([]string{name})
		}
		if stored {
			unpublished = true
			if time.Since(last) >= fsinfoPublishEvery {
				c.s.bus.Publish(bus.RemotesChanged, bus.RemotesChangedData{})
				unpublished, last = false, time.Now()
			}
		}
	}
	if unpublished {
		c.s.bus.Publish(bus.RemotesChanged, bus.RemotesChangedData{})
	}
}

// refresh reads the remote's fsinfo and stores it, unless the remote's config changed in the
// meantime. In that case it reports stale, and a failure says nothing about the new config.
func (c *fsinfoCache) refresh(ctx context.Context, name string, gen int) (stored, stale bool) {
	defer func() {
		c.mu.Lock()
		delete(c.queued, name)
		c.mu.Unlock()
	}()
	if !c.s.exists(name) {
		return false, false
	}
	actx, cancel := context.WithTimeout(ctx, fsinfoTimeout)
	defer cancel()
	fi, err := askFSInfo(actx, name+":", rclone.UIGroup("fsinfo", name))
	c.mu.Lock()
	stale = c.gen[name] != gen
	if err != nil && !stale {
		c.failed[name] = c.s.now()
	} else {
		delete(c.failed, name)
	}
	c.mu.Unlock()
	if stale {
		return false, true
	}
	if err != nil {
		c.s.log.DebugContext(ctx, "remotes: fsinfo refresh failed", "remote", name, "error", err)
		return false, false
	}
	if err := c.store(ctx, name, fi); err != nil {
		c.s.log.ErrorContext(ctx, "remotes: storing fsinfo", "remote", name, "error", err)
		return false, false
	}
	return true, false
}

func (c *fsinfoCache) store(ctx context.Context, name string, fi FSInfo) error {
	enc, err := json.Marshal(fi)
	if err != nil {
		return err
	}
	now := c.s.now().UnixMilli()
	// Only update an existing row, because a remote deleted in the meantime has none.
	return c.s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE remote_fsinfo SET fsinfo = ?, fsinfo_ms = ?, updated_ms = ?
			WHERE remote = ?`, string(enc), now, now, name)
		if err != nil {
			return fmt.Errorf("store fsinfo: %w", err)
		}
		return nil
	})
}
