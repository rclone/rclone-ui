package state

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine"
)

type Core interface {
	List(ctx context.Context, dir string, page func([]engine.Entry)) error
	Services() engine.Services
}

const (
	maxListed     = 2000
	progressEvery = time.Second
)

type State struct {
	store *corestate.Store
	core  Core

	mu       sync.Mutex
	onChange func()

	progressOn  bool
	progressAt  time.Time
	progressDue bool
}

func New(store *corestate.Store, c Core) *State {
	h := &State{store: store, core: c}
	store.Subscribe(h.storeChanged)
	return h
}

func (h *State) storeChanged(changed corestate.Part) {
	if changed == corestate.Progress {
		h.mu.Lock()
		tell := h.progressOn && h.tellProgressLocked()
		h.mu.Unlock()
		if !tell {
			return
		}
	}
	h.changedState()
}

func (h *State) OnChange(fn func()) {
	h.mu.Lock()
	h.onChange = fn
	h.mu.Unlock()
}

func (h *State) changedState() {
	h.mu.Lock()
	fn := h.onChange
	h.mu.Unlock()
	if fn != nil {
		fn()
	}
}

func (h *State) Data() *engine.Data {
	s := h.store.Snapshot()
	d := &engine.Data{
		Remotes: s.Remotes, Mounts: s.Mounts, Serves: s.Serves, Vfs: s.Vfs, Tunnel: s.Tunnel,
		Transfers: s.Transfers, Failed: s.Failed, ServeTypes: s.ServeTypes,
	}
	if s.Ready {
		d.List = h.list
	}
	return d
}

func (h *State) Services() engine.Services {
	if !h.store.Snapshot().Ready {
		return engine.Services{}
	}
	return h.core.Services()
}

func (h *State) RefreshIfOlder(ctx context.Context, age time.Duration) {
	h.store.RefreshIfOlder(ctx, age)
}

func (h *State) FollowProgress(on bool) {
	h.mu.Lock()
	h.progressOn = on
	h.mu.Unlock()
}

func (h *State) tellProgressLocked() bool {
	wait := time.Until(h.progressAt.Add(progressEvery))
	if wait <= 0 {
		h.progressAt = time.Now()
		return true
	}
	if !h.progressDue {
		h.progressDue = true
		time.AfterFunc(wait, func() {
			h.mu.Lock()
			h.progressDue = false
			h.progressAt = time.Now()
			h.mu.Unlock()
			h.changedState()
		})
	}
	return false
}

var errEnough = fmt.Errorf("enough entries")

func (h *State) list(ctx context.Context, dir string, page func([]engine.Entry)) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	n := 0
	err := h.core.List(ctx, dir, func(entries []engine.Entry) {
		if n >= maxListed || len(entries) == 0 {
			return
		}
		page(entries)
		if n += len(entries); n >= maxListed {
			cancel(errEnough)
		}
	})
	if context.Cause(ctx) == errEnough {
		return nil
	}
	return err
}
