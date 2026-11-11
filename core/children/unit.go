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

// Backoff describes the delay before a restart. The delay is Min after the first failure, doubles
// up to Max, and goes back to Min once a run has stayed up for Reset. Retry steps through it.
type Backoff struct {
	Min, Max, Reset time.Duration
}

// RcloneBackoff is the default backoff for every unit whose Spec doesn't set its own.
var RcloneBackoff = Backoff{Min: time.Second, Max: time.Minute, Reset: 5 * time.Minute}

// Retry returns a fresh sequence of b's delays, for one thing that is started again after each
// failure.
func (b Backoff) Retry() *Retry { return &Retry{b: b, delay: b.Min} }

// Retry tracks progress through a Backoff: the next delay and the number of failures in a row.
type Retry struct {
	b       Backoff
	delay   time.Duration
	attempt int
}

// Next records a failure of a run that had stayed up for the duration up. It returns the delay
// before starting again, and how many failures in a row this makes. A run that stayed up for
// Backoff.Reset or longer starts the sequence over.
func (r *Retry) Next(up time.Duration) (delay time.Duration, attempt int) {
	if up >= r.b.Reset {
		r.delay, r.attempt = r.b.Min, 0
	}
	delay = r.delay
	r.attempt++
	r.delay = min(2*r.delay, r.b.Max)
	return delay, r.attempt
}

// Spec describes a unit: one rclone child (`rcui <Rclone…>`) that is started again after its
// backoff whenever it exits on its own, until it is stopped on purpose. OnUp, OnDown and Ready
// run on the unit's goroutine, so they must not call the unit's Stop. To end the unit, Ready
// returns an error and OnDown returns false.
type Spec struct {
	// ID is the child's id of 8 hex digits, used in its socket name and its children.json record.
	// "" means a new id. A mount or serve that is started again after a restart passes its
	// Record.ID.
	ID   string
	Name string // names the child in the supervisor's log lines and in children.json
	// Rclone is the child's arguments (`rcui <args>`), without the flags that every child gets:
	// operations.Mount.Args, operations.Serve.Args, or `tunnel`.
	Rclone []string
	// ConfigPath is the child's config file (--config). ConfigPassword is the file's password
	// when it is encrypted. The password is handed over in a one-time key file (see childenv),
	// never on the command line or in the environment.
	ConfigPath     string
	ConfigPassword string
	// SecretEnv are variables that the child gets on top of the core's environment, such as a
	// serve's credentials (operations.Serve.Env). children.json never records them. Their values
	// and the Secrets (operations.Serve.Secrets) are masked in the child's log lines, because at
	// DEBUG level rclone prints every variable it reads, with its value.
	SecretEnv []string
	Secrets   []string
	// Component and Subcomponent label the child's log lines: mounts/<mount point>,
	// serves/<type>:<addr>, or tunnel/rclone.
	Component, Subcomponent string
	// Parse turns the child's lines into records. The default is logs.RcloneChild.
	Parse logs.LineParser
	// QuietStop logs the child's warnings and errors at info level while it is being stopped on
	// purpose. It is for programs that complain at length when they get SIGTERM.
	QuietStop bool
	// Before, when set, runs before each start of the process, the first one included. An error
	// counts as a failed start, with that error as the reason. A serve checks here that nothing
	// else listens on its address yet, so a restart after a crash doesn't take another
	// program's answer for its own.
	Before func(ctx context.Context) error
	// Ready, when set, blocks until the process is ready (the mount table lists the mount
	// point, or a port answers). ctx ends when the process exits or the unit is stopped. An
	// error takes the unit down.
	Ready func(ctx context.Context, p *Process) error
	// These fields are recorded in children.json, for the cleanup and restore at the next start.
	Kind       Kind
	MountPoint string
	Addr       string
	NFSPort    int
	Meta       json.RawMessage

	// Backoff's zero fields take their values from RcloneBackoff.
	Backoff Backoff
	// OnUp runs each time the child is running and ready.
	OnUp func(u *Unit)
	// OnDown runs each time the unit goes down on its own (not because of a stop), after the
	// child has exited and before the delay. Returning false ends the unit instead of starting it
	// again. nil always starts it again.
	OnDown func(u *Unit, d Down) bool
}

type Down struct {
	Err     error         // why it went down
	WasUp   bool          // the child had been running and ready
	UpFor   time.Duration // how long it had been up
	Attempt int           // failures in a row since it last stayed up for Backoff.Reset
	Delay   time.Duration // the delay before the next start, if there is one
}

type State int

const (
	StateStarting State = iota
	StateUp
	StateDown    // waiting for its backoff delay
	StateStopped // stopped, or ended by OnDown, and its goroutine has returned
)

// Unit is a supervised rclone child. It runs one process at a time.
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
	leaving atomic.Bool // set by Leave: a stop on purpose is coming

	mu    sync.Mutex
	state State
	proc  *Process // the latest run
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

// Process returns the child's running process, or nil when it is not running.
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

// RC returns the child's rc client. It works while the child runs, and its credentials stay
// the same across restarts.
func (u *Unit) RC() *RC { return u.rc }

// Done is closed when the unit's goroutine has returned, after its process has exited and been
// waited for.
func (u *Unit) Done() <-chan struct{} { return u.done }

// Leave marks the unit as about to be stopped on purpose. The starter calls it before its own
// slow part of the stop (a mount reads its upload queue first). From then on, StopAll doesn't
// keep the unit to start again after a restart, as it would for a unit that is still up.
func (u *Unit) Leave() { u.leaving.Store(true) }

// left reports whether a stop on purpose has begun, through Leave or Stop.
func (u *Unit) left() bool { return u.leaving.Load() || u.ctx.Err() != nil }

// Stop stops the unit on purpose, with no restart. The child gets SIGTERM, then SIGKILL after
// 10 s. Stop returns once the process has been waited for, or when ctx ends first.
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

// record returns the child as children.json records it, without the process fields.
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

// run is the unit's goroutine. It starts the child, waits for it to go down, waits out the
// backoff, and repeats until the unit is stopped.
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
		restart := true // stays true when OnDown panics
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

// once starts the child and watches it until it goes down or the unit is stopped. The process has
// exited when once returns. upAt is when the child became ready, or zero if it never did.
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
	// Drain exits left over from an earlier run. They are all planned, because that process was
	// stopped. Only the loop below reads them, and a run that failed to start never reached it.
	// Without the drain, a goroutine blocked on a full channel would stay until the unit ends.
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
			// The exit of an earlier run's process, or of one stopped on purpose, is planned.
			if p.planned.Load() {
				continue
			}
			u.stopRunning()
			return Down{Err: p.exitError()}, upAt
		}
	}
}

// ready waits for the spec's Ready. Ready's context ends when the process exits.
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

// stopProcess ends p on purpose. It sends SIGTERM to p's group, waits for the grace period, then
// sends SIGKILL. It returns once p has been waited for.
func (u *Unit) stopProcess(p *Process) {
	p.planned.Store(true)
	select {
	case <-p.exited:
		return
	default:
	}
	if runtime.GOOS == "windows" {
		p.killed.Store(true) // terminate is a kill on Windows
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

// hook runs one of the starter's functions. If it panics, the panic is logged and hook returns
// false.
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
