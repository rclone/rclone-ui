// Package state is the launcher's Source over the shell's store of the core's state
// (app/corestate). It turns the store's snapshot into the providers' data, adds what only the
// launcher uses (folder listing and the core's services), and tells the launcher when the state
// changes. The progress of running transfers counts as a change only while the launcher is up, and
// at most once a second.
package state

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine"
)

// Core is what the launcher reaches in the core besides the state: listing a folder, and the
// services that actions call.
type Core interface {
	// List lists dir and passes each page of entries to page as it arrives.
	List(ctx context.Context, dir string, page func([]engine.Entry)) error
	Services() engine.Services
}

const (
	maxListed = 2000 // the most entries of a folder that completion considers
	// progressEvery is how often progress of running transfers may update what the launcher
	// shows
	progressEvery = time.Second
)

type State struct {
	store *corestate.Store
	core  Core

	mu       sync.Mutex
	onChange func() // called after the store's state changes

	// Progress of running transfers is followed while the launcher is up (FollowProgress).
	// progressAt is when a progress change was last reported. A change that comes too soon is
	// reported later, once (progressDue).
	progressOn  bool
	progressAt  time.Time
	progressDue bool
}

func New(store *corestate.Store, c Core) *State {
	h := &State{store: store, core: c}
	store.Subscribe(h.storeChanged)
	return h
}

// storeChanged tells the launcher that the state changed. Progress alone is told only while the
// launcher follows it, and at most once every progressEvery.
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

// OnChange registers fn to be called (on the store's subscriber goroutine, or a timer's) each
// time the state changes.
func (h *State) OnChange(fn func()) {
	h.mu.Lock()
	h.onChange = fn
	h.mu.Unlock()
}

// changedState calls the function registered with OnChange.
func (h *State) changedState() {
	h.mu.Lock()
	fn := h.onChange
	h.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// Data returns the core's state, as last read.
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

// Services returns the core's services for the actions. It is empty while the core isn't
// running.
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

// tellProgressLocked reports whether a progress change should be reported now. A change that comes
// less than progressEvery after the last report is reported once that time has passed. h.mu must
// be held.
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

// errEnough stops a listing once it has maxListed entries.
var errEnough = fmt.Errorf("enough entries")

// list lists dir, up to maxListed entries, and passes each page to page as it arrives.
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
