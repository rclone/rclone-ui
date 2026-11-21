// Package corestate keeps the shell's one copy of what the core runs: the remotes, the mounts,
// serves, VFS caches and tunnel, the transfers with their progress, and the serve types. The tray
// and the launcher both read it. The core's events trigger a read of the part they changed, and
// each subscriber is told which parts changed.
package corestate

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/vfs"
)

type Reader interface {
	Remotes(ctx context.Context) ([]engine.Remote, error)
	Mounts(ctx context.Context) ([]mounts.MountRow, error)
	Serves(ctx context.Context) ([]serves.ServeRow, error)
	Vfs(ctx context.Context) ([]vfs.VFS, error)
	// Tunnel reports whether the remote tunnel is on or starting.
	Tunnel(ctx context.Context) (bool, error)
	ActiveTransfers(ctx context.Context) ([]transfers.Transfer, error)
	// EndedTransfers returns the last limit transfers that ended, newest first.
	EndedTransfers(ctx context.Context, limit int) ([]transfers.Transfer, error)
	ServeTypes(ctx context.Context) ([]string, error)
}

// Part is a set of the parts of the state, which tells a subscriber what changed.
type Part uint8

const (
	Remotes Part = 1 << iota
	// Running are the mounts, the serves, the VFS caches and the tunnel.
	Running
	// Transfers are the open transfers and the recent failed ones.
	Transfers
	// Progress is the running transfers' progress, which the core reports every second.
	Progress
	// Types are the serve types.
	Types

	All = Remotes | Running | Transfers | Progress | Types
)

// Snapshot is the state as last read. Its slices and map are never changed once they are in a
// snapshot, so a caller can keep them, but must not change them.
type Snapshot struct {
	// Ready is true while the core is running. Everything else is empty while it isn't.
	Ready   bool
	Remotes []engine.Remote
	Mounts  []mounts.MountRow
	Serves  []serves.ServeRow
	Vfs     []vfs.VFS
	// Tunnel is true while the remote tunnel is on or starting.
	Tunnel bool
	// Transfers are the queued and running transfers, with their latest progress (Live).
	Transfers []transfers.Transfer
	// Failed are the transfers that failed among the last ones to end, newest first.
	Failed []transfers.Transfer
	// Live is the latest progress of the running transfers, by id. An entry goes once its
	// transfer has ended.
	Live       map[string]bus.TransferProgress
	ServeTypes []string
	// Loaded is when the whole state was last read.
	Loaded time.Time
}

const (
	callTimeout = 10 * time.Second
	// endedRead is how many of the last ended transfers are read to find the failed ones.
	endedRead = 20
)

type Store struct {
	r   Reader
	log *slog.Logger

	// Only one read of each kind runs at a time, so an older result never overwrites a newer one.
	remotesRead, runningRead, transfersRead serial

	mu sync.Mutex
	// run counts the core's runs, so the result of a read from a run that has ended is
	// discarded. snap.Ready is true while the core is running.
	run  uint64
	snap Snapshot

	// subs are called in turn on one goroutine (dispatch) with the parts that changed since
	// their last call. pending gathers those parts, and wake starts the next round.
	subs     []subscriber
	nextSub  int
	pending  Part
	wake     chan struct{}
	dispatch sync.Once
}

type subscriber struct {
	id int
	fn func(changed Part)
}

// New creates a Store that reads from r. Nothing is read until CoreReady.
func New(r Reader, log *slog.Logger) *Store {
	return &Store{r: r, log: log, wake: make(chan struct{}, 1)}
}

func (s *Store) CoreReady(ctx context.Context) {
	s.mu.Lock()
	s.snap.Ready = true
	s.run++
	s.mu.Unlock()
	s.spawn("ready", func() { s.refresh(ctx) })
}

// CoreDown clears everything read from the core when the core stops or fails. Whatever was
// running stopped with it, so nothing is listed as running until CoreReady. A read that is still
// in flight is discarded, because its run is over.
func (s *Store) CoreDown() {
	s.mu.Lock()
	s.run++
	s.snap = Snapshot{}
	s.mu.Unlock()
	s.notify(All)
}

// Event handles an event from the core, which the app passes on. The part of the state that the
// event changed is read again. A progress event is merged into the transfers at once.
func (s *Store) Event(ctx context.Context, ev bus.Event) {
	if ev.Name == bus.TransfersProgress {
		if d, ok := ev.Data.(bus.TransfersProgressData); ok {
			s.setProgress(d.Items)
		}
		return
	}
	s.spawn("changed", func() { s.changed(ctx, ev.Name) })
}

func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snap
}

func (s *Store) RefreshIfOlder(ctx context.Context, age time.Duration) {
	s.mu.Lock()
	stale := s.snap.Ready && time.Since(s.snap.Loaded) > age
	s.mu.Unlock()
	if stale {
		s.spawn("refresh", func() { s.refresh(ctx) })
	}
}

// Subscribe calls fn with the parts that changed, each time the state changes, until stop is
// called. Every subscriber is called in turn on one goroutine, and changes that come while it
// runs are gathered into its next call. fn reads Snapshot for the state, so its last call always
// shows the latest state.
func (s *Store) Subscribe(fn func(changed Part)) (stop func()) {
	s.mu.Lock()
	id := s.nextSub
	s.nextSub++
	s.subs = append(s.subs, subscriber{id: id, fn: fn})
	s.mu.Unlock()
	s.dispatch.Do(func() { go s.dispatchLoop() })
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.subs = slices.DeleteFunc(s.subs, func(sub subscriber) bool { return sub.id == id })
	}
}

func (s *Store) notify(p Part) {
	s.mu.Lock()
	s.pending |= p
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default: // a round is already due, and it will see p
	}
}

func (s *Store) dispatchLoop() {
	for range s.wake {
		s.mu.Lock()
		p := s.pending
		s.pending = 0
		subs := slices.Clone(s.subs)
		s.mu.Unlock()
		if p == 0 {
			continue
		}
		for _, sub := range subs {
			s.call(sub.fn, p)
		}
	}
}

// call calls a subscriber. A panic there would end the app, so it is logged instead.
func (s *Store) call(fn func(Part), p Part) {
	defer func() {
		if v := recover(); v != nil {
			s.log.Error("a subscriber of the core's state panicked", "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
		}
	}()
	fn(p)
}

// spawn runs fn on its own goroutine. An unrecovered panic there would end the app, so spawn
// logs it instead, and only fn's work is lost.
func (s *Store) spawn(name string, fn func()) {
	go func() {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("the core's state recovered from a panic", "where", name, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
			}
		}()
		fn()
	}()
}

func (s *Store) changed(ctx context.Context, name string) {
	switch name {
	case bus.RemotesChanged:
		s.refreshRemotes(ctx)
	case bus.MountsChanged, bus.ServesChanged, bus.TunnelChanged:
		s.refreshRunning(ctx)
	case bus.TransfersChanged:
		s.refreshTransfers(ctx)
	case bus.Resync, bus.ConfigChanged:
		s.refresh(ctx)
	}
}

func (s *Store) setProgress(items map[string]bus.TransferProgress) {
	s.mu.Lock()
	if !s.snap.Ready {
		s.mu.Unlock()
		return
	}
	live := maps.Clone(s.snap.Live)
	if live == nil {
		live = make(map[string]bus.TransferProgress, len(items))
	}
	maps.Copy(live, items)
	s.snap.Live = live
	s.snap.Transfers, _ = withProgress(s.snap.Transfers, items)
	s.mu.Unlock()
	s.notify(Progress)
}

// withProgress returns ts with the progress from items added. A queued transfer that has progress
// is marked as running. Transfers missing from items stay as they are, and the next read of the
// transfers drops the ones that ended. changed is false when no transfer had progress.
func withProgress(ts []transfers.Transfer, items map[string]bus.TransferProgress) (out []transfers.Transfer, changed bool) {
	out = make([]transfers.Transfer, len(ts))
	for i, t := range ts {
		out[i] = t
		p, ok := items[t.ID]
		if !ok {
			continue
		}
		out[i].Live = &p
		if t.State == transfers.StateQueued {
			out[i].State = transfers.StateRunning
		}
		changed = true
	}
	return out, changed
}

// liveOf returns the progress of the open transfers ts: what the read found, or else the latest
// progress from before for a transfer that is still open. The entries of the transfers that ended
// are dropped.
func liveOf(ts []transfers.Transfer, before map[string]bus.TransferProgress) map[string]bus.TransferProgress {
	live := make(map[string]bus.TransferProgress, len(ts))
	for _, t := range ts {
		if t.Live != nil {
			live[t.ID] = *t.Live
		} else if p, ok := before[t.ID]; ok {
			live[t.ID] = p
		}
	}
	return live
}

// current returns the core's current run, and whether the core is running.
func (s *Store) current() (run uint64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.run, s.snap.Ready
}

// land stores the result of a read from run, if run is still the current one, and tells the
// subscribers that part changed.
func (s *Store) land(run uint64, part Part, set func(d *Snapshot)) {
	s.mu.Lock()
	ours := s.snap.Ready && s.run == run
	if ours {
		set(&s.snap)
	}
	s.mu.Unlock()
	if ours {
		s.notify(part)
	}
}

func (s *Store) refresh(ctx context.Context) {
	run, ok := s.current()
	if !ok {
		return
	}
	s.refreshRemotes(ctx)
	s.refreshRunning(ctx)
	s.refreshTransfers(ctx)
	s.refreshTypes(ctx)
	s.mu.Lock()
	if s.snap.Ready && s.run == run {
		s.snap.Loaded = time.Now()
	}
	s.mu.Unlock()
}

// serial runs one read of a kind at a time. A read requested while another runs waits for it. It
// is skipped if a newer read is requested in the meantime, because the newer read will see every
// change that the skipped one would have.
type serial struct {
	mu  sync.Mutex
	gen atomic.Uint64
}

func (r *serial) do(read func()) {
	gen := r.gen.Add(1)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gen.Load() != gen {
		return
	}
	read()
}

func (s *Store) refreshRemotes(ctx context.Context) {
	s.remotesRead.do(func() { s.readRemotes(ctx) })
}

func (s *Store) readRemotes(ctx context.Context) {
	run, ok := s.current()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	remotes, err := s.r.Remotes(ctx)
	if err != nil {
		s.log.Debug("could not read the remotes", "error", err)
		return
	}
	s.land(run, Remotes, func(d *Snapshot) { d.Remotes = remotes })
}

func (s *Store) refreshRunning(ctx context.Context) {
	s.runningRead.do(func() { s.readRunning(ctx) })
}

func (s *Store) readRunning(ctx context.Context) {
	run, ok := s.current()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	ms, err := s.r.Mounts(ctx)
	if err != nil {
		s.log.Debug("could not read the mounts", "error", err)
		return
	}
	ss, err := s.r.Serves(ctx)
	if err != nil {
		s.log.Debug("could not read the serves", "error", err)
		return
	}
	caches, err := s.r.Vfs(ctx)
	if err != nil {
		s.log.Debug("could not read the VFS caches", "error", err)
		return
	}
	tunnel, err := s.r.Tunnel(ctx)
	if err != nil {
		s.log.Debug("could not read the tunnel", "error", err)
		return
	}
	s.land(run, Running, func(d *Snapshot) { d.Mounts, d.Serves, d.Vfs, d.Tunnel = ms, ss, caches, tunnel })
}

func (s *Store) refreshTransfers(ctx context.Context) {
	s.transfersRead.do(func() { s.readTransfers(ctx) })
}

func (s *Store) readTransfers(ctx context.Context) {
	run, ok := s.current()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	active, err := s.r.ActiveTransfers(ctx)
	if err != nil {
		s.log.Debug("could not read the transfers", "error", err)
		return
	}
	// if the ended transfers can't be read, keep the failed ones read before
	var failed []transfers.Transfer
	ended, endedErr := s.r.EndedTransfers(ctx, endedRead)
	if endedErr != nil {
		s.log.Debug("could not read the ended transfers", "error", endedErr)
	}
	for _, t := range ended {
		if t.State == transfers.StateFailed {
			failed = append(failed, t)
		}
	}
	s.land(run, Transfers, func(d *Snapshot) {
		d.Live = liveOf(active, d.Live)
		d.Transfers, _ = withProgress(active, d.Live)
		if endedErr == nil {
			d.Failed = failed
		}
	})
}

// refreshTypes reads the serve types once in each of the core's runs, because they don't change.
func (s *Store) refreshTypes(ctx context.Context) {
	run, ok := s.current()
	if !ok {
		return
	}
	s.mu.Lock()
	known := s.snap.ServeTypes != nil
	s.mu.Unlock()
	if known {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	types, err := s.r.ServeTypes(ctx)
	if err != nil {
		s.log.Debug("could not read the serve types", "error", err)
		return
	}
	s.land(run, Types, func(d *Snapshot) { d.ServeTypes = types })
}
