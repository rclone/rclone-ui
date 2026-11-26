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

const stopGrace = 10 * time.Second

var ErrClosed = errors.New("children: the supervisor is stopping")

var errNotBegun = errors.New("children: the supervisor hasn't begun")

type Options struct {
	RunDir      string
	SocketDir   string
	Exe         string
	CacheDir    string
	Emit        func(logs.Record)
	Limits      func() Limits
	LibraryPath string
}

type Supervisor struct {
	o     Options
	log   *slog.Logger
	grace time.Duration
	os    osState

	mu      sync.Mutex
	closing bool
	begun   bool
	units   map[*Unit]struct{}
	ids     map[string]bool
	live    map[string]Record
	pending map[string]Record

	fileMu sync.Mutex
}

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
	delete(s.pending, id)
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

func (s *Supervisor) Pending() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sortedRecords(s.pending)
}

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

func (s *Supervisor) ended(u *Unit) {
	s.mu.Lock()
	delete(s.units, u)
	delete(s.ids, u.id)
	s.mu.Unlock()
}

func (s *Supervisor) started(r Record) {
	s.mu.Lock()
	r.Stopping = s.closing
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
		id := ids.Hex(4)
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

func logEntry(e logs.Record) {
	logs.Logger(e.Component, e.Subcomponent).Log(context.Background(), e.Level, e.Message)
}
