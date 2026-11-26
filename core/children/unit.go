package children

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
)

type Backoff struct {
	Min, Max, Reset time.Duration
}

var RcloneBackoff = Backoff{Min: time.Second, Max: time.Minute, Reset: 5 * time.Minute}

func (b Backoff) Retry() *Retry { return &Retry{b: b, delay: b.Min} }

type Retry struct {
	b       Backoff
	delay   time.Duration
	attempt int
}

func (r *Retry) Next(up time.Duration) (delay time.Duration, attempt int) {
	if up >= r.b.Reset {
		r.delay, r.attempt = r.b.Min, 0
	}
	delay = r.delay
	r.attempt++
	r.delay = min(2*r.delay, r.b.Max)
	return delay, r.attempt
}

type Spec struct {
	ID                      string
	Name                    string
	Rclone                  []string
	ConfigPath              string
	ConfigPassword          string
	SecretEnv               []string
	Secrets                 []string
	Component, Subcomponent string
	Parse                   logs.LineParser
	QuietStop               bool
	Before                  func(ctx context.Context) error
	Ready                   func(ctx context.Context, p *Process) error
	Kind                    Kind
	MountPoint              string
	Addr                    string
	NFSPort                 int
	Meta                    json.RawMessage

	Backoff Backoff
	OnUp    func(u *Unit)
	OnDown  func(u *Unit, d Down) bool
}

type Down struct {
	Err     error
	WasUp   bool
	UpFor   time.Duration
	Attempt int
	Delay   time.Duration
}

type State int

const (
	StateStarting State = iota
	StateUp
	StateDown
	StateStopped
)

type Unit struct {
	s       *Supervisor
	spec    Spec
	id      string
	rc      *RC
	backoff Backoff

	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	exits   chan *Process
	leaving atomic.Bool

	mu    sync.Mutex
	state State
	proc  *Process
}

func newUnit(s *Supervisor, spec Spec, id string) *Unit {
	b, def := spec.Backoff, RcloneBackoff
	if b.Min <= 0 {
		b.Min = def.Min
	}
	if b.Max < b.Min {
		b.Max = max(def.Max, b.Min)
	}
	if b.Reset <= 0 {
		b.Reset = def.Reset
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Unit{
		s:       s,
		spec:    spec,
		id:      id,
		rc:      newRC(rcSock(s.o.SocketDir, id)),
		backoff: b,
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		exits:   make(chan *Process, 2),
	}
}

func (u *Unit) ID() string { return u.id }

func (u *Unit) State() State {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *Unit) Process() *Process {
	u.mu.Lock()
	p := u.proc
	u.mu.Unlock()
	if p == nil {
		return nil
	}
	select {
	case <-p.exited:
		return nil
	default:
		return p
	}
}

func (u *Unit) RC() *RC { return u.rc }

func (u *Unit) Done() <-chan struct{} { return u.done }

func (u *Unit) Leave() { u.leaving.Store(true) }

func (u *Unit) left() bool { return u.leaving.Load() || u.ctx.Err() != nil }

func (u *Unit) Stop(ctx context.Context) error {
	u.cancel()
	select {
	case <-u.done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("children: %s is still stopping: %w", u.spec.Name, ctx.Err())
	}
}

func (u *Unit) setState(st State) {
	u.mu.Lock()
	u.state = st
	u.mu.Unlock()
}

func (u *Unit) record() Record {
	return Record{
		ID:         u.id,
		Kind:       u.spec.Kind,
		Name:       u.spec.Name,
		Args:       slices.Clone(u.spec.Rclone),
		MountPoint: u.spec.MountPoint,
		Addr:       u.spec.Addr,
		NFSPort:    u.spec.NFSPort,
		Meta:       u.spec.Meta,
	}
}

func (u *Unit) run() {
	defer close(u.done)
	defer u.s.ended(u)
	defer u.setState(StateStopped)
	retry := u.backoff.Retry()
	for {
		d, upAt := u.once()
		if u.ctx.Err() != nil {
			return
		}
		if !upAt.IsZero() {
			d.WasUp, d.UpFor = true, time.Since(upAt)
		}
		d.Delay, d.Attempt = retry.Next(d.UpFor)
		u.setState(StateDown)
		restart := true
		if u.spec.OnDown != nil {
			u.hook("OnDown", func() { restart = u.spec.OnDown(u, d) })
		}
		log := u.s.log.With("child", u.spec.Name, "error", d.Err, "attempt", d.Attempt)
		if !restart {
			log.Warn("child went down; not starting it again")
			return
		}
		log.Warn("child went down; starting it again", "in", d.Delay)
		select {
		case <-u.ctx.Done():
			return
		case <-time.After(d.Delay):
		}
	}
}

func (u *Unit) once() (d Down, upAt time.Time) {
	defer func() {
		if r := recover(); r != nil {
			u.s.log.Error("the supervisor panicked", "panic", r, "stack", string(debug.Stack()))
			u.stopRunning()
			// i18n: Why a mount, a serve or the tunnel went down: the app's own supervisor failed.
			d = Down{Err: TextError(i18n.M("the supervisor panicked: %v", r), nil)}
		}
	}()
	u.setState(StateStarting)
	for drained := false; !drained; {
		select {
		case <-u.exits:
		default:
			drained = true
		}
	}
	if u.ctx.Err() != nil {
		return Down{}, time.Time{}
	}
	if u.spec.Before != nil {
		var err error
		if !u.hook("Before", func() { err = u.spec.Before(u.ctx) }) {
			// i18n: Why a mount or a serve could not start: the app's own check failed.
			err = TextError(i18n.M("its check before the start panicked"), nil)
		}
		if err != nil {
			return Down{Err: err}, time.Time{}
		}
	}
	p, err := u.spawn()
	if err == nil {
		err = u.ready(p)
	}
	if err != nil {
		u.stopRunning()
		return Down{Err: err}, time.Time{}
	}
	upAt = time.Now()
	u.setState(StateUp)
	if u.spec.OnUp != nil {
		u.hook("OnUp", func() { u.spec.OnUp(u) })
	}
	for {
		select {
		case <-u.ctx.Done():
			u.stopRunning()
			return Down{}, upAt
		case p := <-u.exits:
			if p.planned.Load() {
				continue
			}
			u.stopRunning()
			return Down{Err: p.exitError()}, upAt
		}
	}
}

func (u *Unit) ready(p *Process) error {
	if u.spec.Ready != nil {
		ctx, cancel := context.WithCancel(u.ctx)
		defer cancel()
		go func() {
			select {
			case <-p.exited:
				cancel()
			case <-ctx.Done():
			}
		}()
		var err error
		if !u.hook("Ready", func() { err = u.spec.Ready(ctx, p) }) {
			// i18n: Why a mount or a serve could not start: the app's own check failed.
			err = TextError(i18n.M("its readiness check panicked"), nil)
		}
		select {
		case <-p.exited:
			// i18n: Why a mount or a serve could not start. The first value is its mount point or address, the second how its process ended.
			return TextError(i18n.M("%s exited before it was ready: %w", u.spec.Name, p.exitError()), p.exitError())
		default:
		}
		if err != nil {
			if u.ctx.Err() != nil {
				return u.ctx.Err()
			}
			// i18n: Why a mount or a serve could not start. The first value is its mount point or address, the second the reason.
			return TextError(i18n.M("%s is not ready: %w", u.spec.Name, err), err)
		}
	}
	select {
	case <-p.exited:
		return fmt.Errorf("%s: %w", u.spec.Name, p.exitError())
	default:
		return nil
	}
}

func (u *Unit) stopRunning() {
	u.mu.Lock()
	p := u.proc
	u.mu.Unlock()
	if p != nil {
		u.stopProcess(p)
	}
}

func (u *Unit) stopProcess(p *Process) {
	p.planned.Store(true)
	select {
	case <-p.exited:
		return
	default:
	}
	if runtime.GOOS == "windows" {
		p.killed.Store(true)
	}
	if err := terminate(p.cmd.Process); err != nil {
		u.s.log.Warn("could not signal a child to stop", "child", u.spec.Name, "pid", p.pid, "error", err)
	}
	t := time.NewTimer(u.s.grace)
	defer t.Stop()
	select {
	case <-p.exited:
		return
	case <-t.C:
	}
	u.s.log.Warn("a child did not stop in time; killing it", "child", u.spec.Name, "pid", p.pid, "waited", u.s.grace)
	p.killed.Store(true)
	if err := kill(p.cmd.Process); err != nil {
		u.s.log.Error("could not kill a child", "child", u.spec.Name, "pid", p.pid, "error", err)
	}
	<-p.exited
}

func (u *Unit) hook(name string, fn func()) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			u.s.log.Error("a child's "+name+" panicked", "child", u.spec.Name, "panic", r,
				"stack", string(debug.Stack()))
			ok = false
		}
	}()
	fn()
	return true
}
