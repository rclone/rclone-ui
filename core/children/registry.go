package children

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
)

// Status is the state of a mount or serve. Failed and stopped are reported once, in the changed
// event sent as it leaves its service's list.
type Status string

const (
	StatusStarting   Status = "starting"   // started, but not ready yet
	StatusRunning    Status = "running"    // ready: the mount table lists it, or its address answers
	StatusRestarting Status = "restarting" // crashed, and starting again after its backoff
	StatusFailed     Status = "failed"     // the first start failed, and it was removed
	StatusStopped    Status = "stopped"    // a user stopped it, and it was removed
)

const (
	readyEvery   = 250 * time.Millisecond
	maxErrorText = 1000 // the longest error text kept for why a child went down
	// freshErr is how recent an error line must be to explain why a child that was running went
	// down. An older line is about something it got past, so how the process exited says more.
	freshErr = 30 * time.Second
)

// ErrNotRecorded is returned by Resume's start function for a record from the previous run that
// lacks the arguments needed to start it again. The record is then dropped.
var ErrNotRecorded = errors.New("its arguments are not recorded")

type Configs interface {
	Path() string
	// ChildPassword returns "" for a plain file, and an error when the password of an encrypted
	// file is not known.
	ChildPassword(ctx context.Context) (string, error)
}

// ConfigError is returned when a start can't get the password of its config file
// (Configs.ChildPassword).
type ConfigError struct {
	Path string
	Err  error
}

func (e *ConfigError) Error() string { return e.Path + ": " + e.Err.Error() }

func (e *ConfigError) Unwrap() error { return e.Err }

// Registry holds a service's mounts or serves (core/mounts, core/serves), each a unit with one
// rclone child. T holds the part that is specific to the service, and the service's own steps
// are the hooks in RegistryOptions.
type Registry[T any] struct {
	o    RegistryOptions[T]
	kind string // "mount" or "serve", used in log lines

	mu      sync.Mutex
	entries map[string]*Child[T]

	// stops tracks the goroutines that run the stops (see stop). They can outlive a Stop that
	// returned early, so the core's shutdown waits for them (WaitStops) before the database closes.
	stops sync.WaitGroup
}

type RegistryOptions[T any] struct {
	Kind Kind
	// Component is the log component of its children's lines (logs.CompMounts).
	Component string
	Children  *Supervisor
	Configs   Configs
	// NotFound is the error Stop returns for a child that is no longer running.
	NotFound error
	Now      func() time.Time // default time.Now
	// ReadyTimeout limits how long a child may take to become ready, counted from its process's
	// start. StopWait limits how long a stop waits for the child to exit. Backoff is used by its
	// units (zero means RcloneBackoff).
	ReadyTimeout, StopWait time.Duration
	Backoff                Backoff

	// Publish sends the service's changed event: c is now at status st, and msg says why it went
	// down (nil when it didn't). msg is rclone's error line, or an error whose message is
	// translatable, which a page shows with i18n.Localize. It is called without the registry's
	// lock held.
	Publish func(c *Child[T], st Status, msg error)
	// Up runs each time c becomes ready, before that is published. nil does nothing.
	Up func(c *Child[T])
	// Down runs each time c's process goes down on its own (not because of a stop), before that
	// is published. again reports whether c starts again after its backoff, which happens only if
	// it has been ready before. When again is false, Down runs before c leaves the registry. msg
	// says why it went down. nil does nothing.
	Down func(c *Child[T], msg error, again bool)
	// OnStop runs when a user's stop begins, before the child is signalled. The function it
	// returns runs once the child has exited, before c leaves the registry. nil does nothing.
	OnStop func(ctx context.Context, c *Child[T]) func(ctx context.Context)
}

// Child is one mount or serve in a Registry. Its exported fields are set before Spawn and are
// only read after it.
type Child[T any] struct {
	ID      string // set by Reserve
	Name    string // the mount point or <type>:<addr>, used in logs and children.json
	Source  string // as entered in the form
	Started time.Time
	Log     *slog.Logger
	Own     T

	unit atomic.Pointer[Unit] // nil until Spawn has started it

	// Guarded by Registry.mu.
	status    Status
	pid       int
	err       error     // why it last went down
	lastErr   string    // the last error line from its process in the current run
	lastErrAt time.Time // when that line was read
	everUp    bool
	stopping  bool
	// restart is set when a remote it uses changed after its process started. The process keeps
	// what it read of the config, so it needs a restart for the change to apply.
	restart bool
}

type Report struct {
	Status Status
	PID    int   // its process, while it runs
	Err    error // why it last went down, nil while it runs
	// Restart is true when a remote it uses changed after its process started (RemotesChanged).
	Restart bool
}

type Launch struct {
	// Spec describes the process. Spawn sets its ID, Name, Kind, ConfigPath, Component,
	// Subcomponent, Parse, Ready, Backoff, OnUp and OnDown.
	Spec Spec
	// Ready reports whether the child is ready now (the mount table lists it, or its address
	// answers). It is polled every 250 ms, up to ReadyTimeout after the process starts. An error
	// takes the child down. Late says what didn't happen within the timeout it is given ("it was
	// not mounted within 30s"), as a text made with i18n.M.
	Ready func(ctx context.Context) (bool, error)
	Late  func(within time.Duration) i18n.Text
	// Check, when set, runs before each start of the process. An error fails that start, with
	// the error as the reason (Spec.Before).
	Check func(ctx context.Context) error
}

func NewRegistry[T any](o RegistryOptions[T]) *Registry[T] {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Registry[T]{o: o, kind: string(o.Kind), entries: map[string]*Child[T]{}}
}

// Unit returns c's unit, or nil until Spawn has started it.
func (c *Child[T]) Unit() *Unit { return c.unit.Load() }

// Config returns the config file that a child runs on and its password, which is "" for a plain
// file. When the password can't be found, the error is a *ConfigError.
func (r *Registry[T]) Config(ctx context.Context) (config, password string, err error) {
	path := r.o.Configs.Path()
	password, err = r.o.Configs.ChildPassword(ctx)
	if err != nil {
		return "", "", &ConfigError{Path: path, Err: err}
	}
	return path, password, nil
}

// Reserve adds c to the registry as starting, under id. When id is "", it picks a new id that
// is not used by any record from the previous run. check runs first, under the lock, with every
// other child. It refuses a place that another child already has, and may also set c.Own (for
// example, a Windows drive).
func (r *Registry[T]) Reserve(c *Child[T], id string, check func(others []*Child[T]) error) error {
	taken := map[string]bool{}
	for _, rec := range r.o.Children.Pending() {
		taken[rec.ID] = true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	others := make([]*Child[T], 0, len(r.entries))
	for _, o := range r.entries {
		others = append(others, o)
	}
	if err := check(others); err != nil {
		return err
	}
	if id == "" {
		for id == "" || r.entries[id] != nil || taken[id] {
			id = ids.Hex(4)
		}
	} else if r.entries[id] != nil {
		return fmt.Errorf("a %s with id %s is running", r.kind, id)
	}
	c.ID, c.status = id, StatusStarting
	r.entries[id] = c
	return nil
}

func (r *Registry[T]) Drop(c *Child[T]) {
	r.mu.Lock()
	if r.entries[c.ID] == c {
		delete(r.entries, c.ID)
	}
	r.mu.Unlock()
}

func (r *Registry[T]) Get(id string) *Child[T] {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.entries[id]
}

// All returns every child, oldest first.
func (r *Registry[T]) All() []*Child[T] {
	return r.sorted(func(*Child[T]) bool { return true })
}

// Live returns every child that is not being stopped, oldest first. These are the children that
// a quit or an update would stop.
func (r *Registry[T]) Live() []*Child[T] {
	return r.sorted(func(c *Child[T]) bool { return !c.stopping })
}

func (r *Registry[T]) sorted(keep func(*Child[T]) bool) []*Child[T] {
	r.mu.Lock()
	var out []*Child[T]
	for _, c := range r.entries {
		if keep(c) {
			out = append(out, c)
		}
	}
	r.mu.Unlock()
	slices.SortFunc(out, func(a, b *Child[T]) int {
		return cmp.Or(cmp.Compare(a.Started.UnixMilli(), b.Started.UnixMilli()), strings.Compare(a.ID, b.ID))
	})
	return out
}

func (r *Registry[T]) View(c *Child[T]) (Report, T) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Report{Status: c.status, PID: c.pid, Err: c.err, Restart: c.restart}, c.Own
}

// Spawn starts c's process. c must have been reserved. When the supervisor refuses the start
// (ErrClosed, because the core is stopping), c leaves the registry and failed is published.
func (r *Registry[T]) Spawn(c *Child[T], l Launch) error {
	spec := l.Spec
	spec.ID, spec.Name, spec.Kind, spec.ConfigPath = c.ID, c.Name, r.o.Kind, r.o.Configs.Path()
	spec.Component, spec.Subcomponent = r.o.Component, c.Name
	spec.Parse, spec.Ready = r.parser(c), r.ready(c, l.Ready, l.Late)
	spec.Before = r.before(c, l.Check)
	spec.Backoff = r.o.Backoff
	spec.OnUp = func(u *Unit) { r.up(c, u) }
	spec.OnDown = func(_ *Unit, d Down) bool { return r.down(c, d) }
	r.o.Publish(c, StatusStarting, nil)
	u, err := r.o.Children.Start(spec)
	if err != nil {
		r.Drop(c)
		r.o.Publish(c, StatusFailed, clipped(err))
		return err
	}
	c.unit.Store(u)
	return nil
}

// parser parses c's lines like any rclone child's, and keeps the last error line, which
// explains why a start failed.
func (r *Registry[T]) parser(c *Child[T]) logs.LineParser {
	base := logs.RcloneChild(r.o.Component, c.Name)
	return func(line string, stream logs.Stream, now time.Time) (logs.Record, bool) {
		en, ok := base(line, stream, now)
		if ok && en.Level >= slog.LevelError {
			r.mu.Lock()
			c.lastErr, c.lastErrAt = clip(en.Message, maxErrorText), r.o.Now()
			r.mu.Unlock()
		}
		return en, ok
	}
}

// before builds c's Spec.Before. It clears c.restart, because each start reads the config again.
func (r *Registry[T]) before(c *Child[T], check func(ctx context.Context) error) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		r.mu.Lock()
		c.restart = false
		r.mu.Unlock()
		if check == nil {
			return nil
		}
		return check(ctx)
	}
}

func (r *Registry[T]) ready(c *Child[T], probe func(ctx context.Context) (bool, error), late func(time.Duration) i18n.Text) func(ctx context.Context, p *Process) error {
	return func(ctx context.Context, p *Process) error {
		deadline := time.NewTimer(time.Until(p.Started().Add(r.o.ReadyTimeout)))
		defer deadline.Stop()
		tick := time.NewTicker(readyEvery)
		defer tick.Stop()
		for {
			ok, err := probe(ctx)
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-deadline.C:
				return TextError(late(r.o.ReadyTimeout), nil)
			case <-tick.C:
			}
		}
	}
}

func (r *Registry[T]) up(c *Child[T], u *Unit) {
	r.mu.Lock()
	if c.stopping {
		r.mu.Unlock()
		return
	}
	c.status, c.everUp, c.err = StatusRunning, true, nil
	if p := u.Process(); p != nil {
		c.pid = p.PID()
	}
	r.mu.Unlock()
	if r.o.Up != nil {
		r.o.Up(c)
	}
	r.o.Publish(c, StatusRunning, nil)
}

// down is c's Spec.OnDown. A first start that fails is the end of c. A child that has run before
// is started again after its backoff. A child that is being stopped is left to stop, which
// publishes the result.
func (r *Registry[T]) down(c *Child[T], d Down) bool {
	r.mu.Lock()
	if c.stopping {
		r.mu.Unlock()
		return false
	}
	// Clear the last error line, so the next run starts fresh. This happens here rather than when
	// the next run starts, because a child that fails at once may log why before its readiness
	// is first checked.
	var msg error
	if c.lastErr != "" && (!d.WasUp || r.o.Now().Sub(c.lastErrAt) <= freshErr) {
		msg = errors.New(c.lastErr) // rclone's own words
	}
	c.lastErr, c.lastErrAt = "", time.Time{}
	if msg == nil && d.Err != nil {
		msg = clipped(d.Err)
	}
	again := c.everUp
	if again {
		c.status, c.err, c.pid = StatusRestarting, msg, 0
	}
	r.mu.Unlock()
	if r.o.Down != nil {
		r.o.Down(c, msg, again)
	}
	if !again {
		r.Drop(c)
		r.o.Publish(c, StatusFailed, msg)
		c.Log.Error("the "+r.kind+" failed", "source", c.Source, "error", msg)
		return false
	}
	r.o.Publish(c, StatusRestarting, msg)
	c.Log.Warn("the "+r.kind+" went down; starting it again", "source", c.Source, "error", msg, "in", d.Delay)
	return true
}

// Stop stops the child with the given id: SIGTERM, a 10 s wait, then SIGKILL (on Windows, a
// kill). It returns once the child is gone, or an error if the child hasn't exited within
// StopWait. In that case, and also when ctx ends first, the stop carries on in the background,
// and the changed event reports when the child is stopped. A restart that begins in the meantime
// does not bring the child back.
func (r *Registry[T]) Stop(ctx context.Context, id string) error {
	r.mu.Lock()
	c := r.entries[id]
	if c == nil || c.Unit() == nil || c.stopping {
		r.mu.Unlock()
		return r.o.NotFound
	}
	c.stopping = true
	c.Unit().Leave()
	r.mu.Unlock()
	answer := make(chan error, 1)
	r.stops.Go(func() { r.stop(context.WithoutCancel(ctx), c, answer) })
	select {
	case err := <-answer:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// stop runs one stop on its own goroutine. It sends nil on answer once the child is gone, or an
// error if the child hasn't exited within StopWait. After an error it keeps waiting, and still
// cleans up once the child exits.
func (r *Registry[T]) stop(ctx context.Context, c *Child[T], answer chan<- error) {
	u := c.Unit()
	after := func(context.Context) {}
	if r.o.OnStop != nil {
		after = r.o.OnStop(ctx, c)
	}
	sctx, cancel := context.WithTimeout(ctx, r.o.StopWait)
	err := u.Stop(sctx)
	cancel()
	if err != nil {
		c.Log.ErrorContext(ctx, "the "+r.kind+" is slow to stop; it is cleaned up once it has", "error", err)
		answer <- err
		<-u.Done()
	}
	after(ctx)
	r.Drop(c)
	r.o.Publish(c, StatusStopped, nil)
	c.Log.InfoContext(ctx, "stopped the "+r.kind, "source", c.Source)
	if err == nil {
		answer <- nil
	}
}

// StopAll stops every child. It returns how many it stopped, and the joined errors of those that
// couldn't be stopped. A child that went away in the meantime counts as neither.
func (r *Registry[T]) StopAll(ctx context.Context) (int, error) {
	var errs []error
	n := 0
	for _, c := range r.All() {
		switch err := r.Stop(ctx, c.ID); {
		case err == nil:
			n++
		case !errors.Is(err, r.o.NotFound):
			errs = append(errs, fmt.Errorf("%s: %w", c.Name, err))
		}
	}
	return n, errors.Join(errs...)
}

// WaitStops waits for the stops begun so far to finish, including their cleanup (a mount's mount
// point cleared and its cache settled). It waits at most d, and never past ctx, and reports
// whether they finished.
func (r *Registry[T]) WaitStops(ctx context.Context, d time.Duration) bool {
	return syncx.Wait(ctx, &r.stops, d)
}

// RemotesChanged sets the restart flag (Child.restart) of the children that uses picks, because a
// remote they use has changed. The flag clears at the next start. A child that is being stopped,
// or is already flagged, is left as it is. Each newly flagged child is published with its current
// status.
func (r *Registry[T]) RemotesChanged(uses func(c *Child[T]) bool) {
	type flagged struct {
		c  *Child[T]
		st Status
	}
	var out []flagged
	r.mu.Lock()
	for _, c := range r.entries {
		if c.Unit() == nil || c.stopping || c.restart || !uses(c) {
			continue
		}
		c.restart = true
		out = append(out, flagged{c, c.status})
	}
	r.mu.Unlock()
	for _, f := range out {
		r.o.Publish(f.c, f.st, nil)
	}
}

// RC returns a running child's rc client, or nil when the child is not running.
func (r *Registry[T]) RC(id string) *RC {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.entries[id]
	if c == nil || c.Unit() == nil || c.stopping || c.status != StatusRunning {
		return nil
	}
	return c.Unit().RC()
}

// Resume calls start, in order, for each record of the registry's kind from the previous run.
// These are the pending records in children.json, kept by a planned restart or left by a crash
// while they were running. start either starts the child again or returns why it can't
// (ErrNotRecorded, or the start's error). In that case the record is dropped and Resume moves on
// to the next one. Resume stops early and returns false when the core stops during it (Closing).
// The records it didn't start stay pending, and the supervisor's StopAll decides which to keep.
func (r *Registry[T]) Resume(ctx context.Context, start func(rec Record) error) bool {
	var drop []string
	done := true
	for _, rec := range r.o.Children.Pending() {
		if rec.Kind != r.o.Kind {
			continue
		}
		if err := start(rec); err != nil {
			if Closing(ctx, err) {
				done = false
				break
			}
			drop = append(drop, rec.ID)
		}
	}
	if len(drop) > 0 {
		r.o.Children.DropPending(drop...)
	}
	return done
}

// Closing reports whether err means the core stopped during a start (the supervisor is closing,
// or ctx ended), rather than the child failing. Such an error needs no report.
func Closing(ctx context.Context, err error) bool {
	return errors.Is(err, ErrClosed) || ctx.Err() != nil
}

// clipped returns err, or its text cut to maxErrorText when it is longer (see clip). The core's own
// messages are short, so they stay translatable.
func clipped(err error) error {
	if text := err.Error(); len(text) > maxErrorText || !utf8.ValidString(text) {
		return errors.New(clip(text, maxErrorText))
	}
	return err
}

// clip cuts s to at most n bytes on a character boundary, adds an ellipsis when it cuts, and
// makes the result valid UTF-8. The pages show a child's error text as is.
func clip(s string, n int) string {
	if len(s) > n {
		cut := n
		for cut > 0 && cut > n-utf8.UTFMax && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return strings.ToValidUTF8(s, "�")
}
