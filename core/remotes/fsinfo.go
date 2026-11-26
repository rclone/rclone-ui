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
	fsinfoMaxAge       = 24 * time.Hour
	fsinfoRetry        = time.Minute
	fsinfoTimeout      = 30 * time.Second
	fsinfoPublishEvery = 2 * time.Second
)

type fsinfoCache struct {
	s *Service

	mu      sync.Mutex
	pending []string
	queued  map[string]bool
	failed  map[string]time.Time
	running bool
	gen     map[string]int
}

func newFSInfoCache(s *Service) *fsinfoCache {
	return &fsinfoCache{s: s, queued: map[string]bool{}, failed: map[string]time.Time{}, gen: map[string]int{}}
}

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

func (c *fsinfoCache) forget(names []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range names {
		c.gen[n]++
		delete(c.failed, n)
	}
}

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
	return c.s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE remote_fsinfo SET fsinfo = ?, fsinfo_ms = ?, updated_ms = ?
			WHERE remote = ?`, string(enc), now, now, name)
		if err != nil {
			return fmt.Errorf("store fsinfo: %w", err)
		}
		return nil
	})
}
