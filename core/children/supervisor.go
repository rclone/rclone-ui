// Package children supervises the core's child processes. These are rclone children
// (`rcui mount|nfsmount|cmount|serve|tunnel …`): one per mount or serve, plus the remote tunnel.
// A Unit is one child. The supervisor waits for it to be ready (Spec.Ready), and starts it again
// with backoff when it exits on its own, unless it was stopped on purpose. A stop sends SIGTERM
// to the child's process group, waits 10 s, then sends SIGKILL. On Windows a stop is a kill, and
// every child is in one kill-on-close Job Object. Every process is waited for (Wait) before its
// unit reports it gone.
//
// Each running process, and each mount or serve to start again after a restart, is recorded in
// <run>/children.json. ClearLeftovers reads that file at the next start.
//
// A rclone child runs on its own config file (--config). When that file is encrypted, the child
// gets its key through a one-time key file (see childenv). It also gets the flags that every child
// gets, and an rc server on <sockets>/c-<id>.sock with random basic-auth credentials (RC). The
// child ends when the core's end of its stdin closes (see childenv), so if the app dies it never
// leaves a child behind.
package children

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/logs"
)

// stopGrace is how long a child has to end after SIGTERM before it is killed.
const stopGrace = 10 * time.Second

// ErrClosed is returned by Start once the supervisor is stopping every child. No new child
// starts after that.
var ErrClosed = errors.New("children: the supervisor is stopping")

// errNotBegun is returned by Start before Begin. The core calls Begin before anything can start a
// child, so only a mistake returns it.
var errNotBegun = errors.New("children: the supervisor hasn't begun")

type Options struct {
	RunDir string // holds children.json and the children's one-time key files
	// SocketDir is the folder for the children's rc sockets (datadir.SocketDir). It is short,
	// because socket paths have a length limit. "" means RunDir.
	SocketDir string
	// Exe is this binary, which runs the rclone children (`rcui mount …` takes rclone's own
	// command line).
	Exe string
	// CacheDir is rclone's cache folder (<data>/cache). It is passed as a child's --cache-dir
	// unless the child's own arguments already set one (the stable folder of a mount or serve).
	CacheDir string
	// Emit receives every line that a child prints, after parsing (the log's Append). nil logs
	// the lines through slog.
	Emit func(logs.Record)
	// Limits returns the options that each rclone child starts with. nil means ParentLimits.
	Limits func() Limits
	// LibraryPath is the AppImage's LD_LIBRARY_PATH (AppImageLibraryPath). Every child runs this
	// executable, so it needs that path back to load its libraries. It is "" outside an AppImage.
	LibraryPath string
}

type Supervisor struct {
	o     Options
	log   *slog.Logger
	grace time.Duration
	os    osState

	mu      sync.Mutex
	closing bool
	// begun is set by Begin. Until then, no child starts and children.json is left alone.
	begun   bool
	units   map[*Unit]struct{}
	ids     map[string]bool   // ids of the units that are still supervised
	live    map[string]Record // running processes, by child id
	pending map[string]Record // records to start again after a restart, by id

	fileMu sync.Mutex // allows one children.json write at a time, in snapshot order
}

// New creates the supervisor. It writes nothing: children.json keeps the previous run's records
// until Begin.
func New(o Options) (*Supervisor, error) {
	if o.RunDir == "" {
		return nil, errors.New("children: no run dir")
	}
	if o.SocketDir == "" {
		o.SocketDir = o.RunDir
	}
	if n, max := len(rcSock(o.SocketDir, "00000000")), maxSocketPath(); n > max {
		return nil, fmt.Errorf("children: the sockets' folder %s is too long for a socket path (%d bytes, the most is %d): set a shorter one with APP_RUN_DIR", o.SocketDir, n, max)
	}
	if o.Emit == nil {
		o.Emit = logEntry
	}
	if o.Limits == nil {
		o.Limits = ParentLimits
	}
	s := &Supervisor{
		o:       o,
		log:     logs.Logger(logs.CompChildren, logs.SubSupervisor),
		grace:   stopGrace,
		units:   map[*Unit]struct{}{},
		ids:     map[string]bool{},
		live:    map[string]Record{},
		pending: map[string]Record{},
	}
	return s, nil
}

// Begin lets children start, once ClearLeftovers has dealt with the previous run's. pending are
// the records that ClearLeftovers returned to start again (Leftovers.Restore). They stay in
// children.json until they are started again (by a Spec with the same ID) or dropped
// (DropPending). Begin then writes children.json. Before Begin, the file holds the previous run's
// records, which the next start needs if this one fails first.
func (s *Supervisor) Begin(pending []Record) error {
	s.mu.Lock()
	for _, r := range pending {
		if validID(r.ID) {
			r.PID, r.StartTime, r.Restore = 0, 0, true
			s.pending[r.ID] = r
		}
	}
	s.begun = true
	s.mu.Unlock()
	return s.save()
}

// Start supervises the child described by spec until the unit is stopped (Unit.Stop, StopAll)
// or its OnDown declines a restart. The first start happens on the unit's own goroutine.
func (s *Supervisor) Start(spec Spec) (*Unit, error) {
	if err := s.check(spec); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return nil, ErrClosed
	}
	if !s.begun {
		s.mu.Unlock()
		return nil, errNotBegun
	}
	id := spec.ID
	if id == "" {
		id = s.newIDLocked()
	} else if s.ids[id] {
		s.mu.Unlock()
		return nil, fmt.Errorf("children: a child with id %s is already supervised", id)
	}
	s.ids[id] = true
	delete(s.pending, id) // a pending record that is now started again
	u := newUnit(s, spec, id)
	s.units[u] = struct{}{}
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.log.Error("could not write children.json", "error", err)
	}
	go u.run()
	return u, nil
}

func (s *Supervisor) check(spec Spec) error {
	switch {
	case spec.Name == "":
		return errors.New("children: a child needs a name")
	case len(spec.Rclone) == 0:
		return fmt.Errorf("children: %s: no rclone command line", spec.Name)
	case spec.ID != "" && !validID(spec.ID):
		return fmt.Errorf("children: %s: id %q is not 8 hex characters", spec.Name, spec.ID)
	case s.o.Exe == "":
		return fmt.Errorf("children: %s: rclone children need Options.Exe", spec.Name)
	case spec.ConfigPath == "":
		return fmt.Errorf("children: %s: a rclone child needs its config file", spec.Name)
	}
	return nil
}

// StopAll stops every unit in parallel and waits for every process, because a relaunch must not
// exec while a process is left unwaited. restore picks the mounts and serves to start again
// after a planned restart. Those, and the pending records that restore keeps, stay in
// children.json as Restore records. A nil restore (a plain shutdown) keeps none. Every running
// record is marked Stopping first, so a child that is still stopping when ctx ends doesn't come
// back at the next start the way a crashed one would. No unit starts after StopAll.
func (s *Supervisor) StopAll(ctx context.Context, restore func(Record) bool) error {
	s.mu.Lock()
	s.closing = true
	units := make([]*Unit, 0, len(s.units))
	for u := range s.units {
		units = append(units, u)
	}
	candidates := sortedRecords(s.pending)
	s.mu.Unlock()
	for _, u := range units {
		// A unit that its OnDown ended, or that a user is stopping, doesn't come back.
		if u.State() == StateStopped || u.left() {
			continue
		}
		if r := u.record(); r.restorable() {
			r.Restore = true
			candidates = append(candidates, r)
		}
	}
	keep := map[string]Record{}
	for _, r := range candidates {
		if restore != nil && restore(r) {
			keep[r.ID] = r
		}
	}
	s.mu.Lock()
	s.pending = keep
	for id, r := range s.live {
		r.Stopping = true
		s.live[id] = r
	}
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.log.Error("could not write children.json", "error", err)
	}

	var wg sync.WaitGroup
	errs := make([]error, len(units))
	for i, u := range units {
		wg.Go(func() {
			errs[i] = u.Stop(ctx)
		})
	}
	wg.Wait()
	if err := s.save(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (s *Supervisor) CacheDir() string { return s.o.CacheDir }

// Pending returns the mounts and serves from before a restart that have not been started
// again yet.
func (s *Supervisor) Pending() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sortedRecords(s.pending)
}

// DropPending forgets pending records that the app decided not to start again. Once StopAll has
// begun, it does nothing, because StopAll chooses which records to keep. A Boot that is still
// running must not drop a record it couldn't start only because of the stop.
func (s *Supervisor) DropPending(ids ...string) {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return
	}
	for _, id := range ids {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.log.Error("could not write children.json", "error", err)
	}
}

// ended removes a unit whose goroutine has returned.
func (s *Supervisor) ended(u *Unit) {
	s.mu.Lock()
	delete(s.units, u)
	delete(s.ids, u.id)
	s.mu.Unlock()
}

func (s *Supervisor) started(r Record) {
	s.mu.Lock()
	r.Stopping = s.closing // the process was spawned just as StopAll began
	s.live[r.ID] = r
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.log.Error("could not write children.json", "error", err)
	}
}

func (s *Supervisor) exited(id string) {
	s.mu.Lock()
	delete(s.live, id)
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.log.Error("could not write children.json", "error", err)
	}
}

// save writes the running processes and the pending records to children.json. Before Begin it
// writes nothing, so a stop after a failed start keeps the previous run's records.
func (s *Supervisor) save() error {
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	s.mu.Lock()
	if !s.begun {
		s.mu.Unlock()
		return nil
	}
	recs := append(sortedRecords(s.live), sortedRecords(s.pending)...)
	s.mu.Unlock()
	return writeRecords(s.o.RunDir, recs)
}

func sortedRecords(m map[string]Record) []Record {
	out := make([]Record, 0, len(m))
	for _, r := range m {
		out = append(out, r)
	}
	slices.SortFunc(out, func(a, b Record) int { return strings.Compare(a.ID, b.ID) })
	return out
}

func (s *Supervisor) newIDLocked() string {
	for {
		id := ids.Hex(4) // 8 hex digits, as validID expects
		if !s.ids[id] {
			if _, ok := s.pending[id]; !ok {
				return id
			}
		}
	}
}

func validID(id string) bool {
	if len(id) != 8 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && strings.ToLower(id) == id
}

// maxSocketPath is the longest unix socket path that the OS accepts (sun_path minus its NUL).
func maxSocketPath() int {
	if runtime.GOOS == "darwin" {
		return 103
	}
	return 107
}

// logEntry is the default Emit. It logs a child's line through slog.
func logEntry(e logs.Record) {
	logs.Logger(e.Component, e.Subcomponent).Log(context.Background(), e.Level, e.Message)
}
