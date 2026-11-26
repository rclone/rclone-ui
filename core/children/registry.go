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

type Status string

const (
	StatusStarting   Status = "starting"
	StatusRunning    Status = "running"
	StatusRestarting Status = "restarting"
	StatusFailed     Status = "failed"
	StatusStopped    Status = "stopped"
)

const (
	readyEvery   = 250 * time.Millisecond
	maxErrorText = 1000
	freshErr     = 30 * time.Second
)

var ErrNotRecorded = errors.New("its arguments are not recorded")

type Configs interface {
	Path() string
	ChildPassword(ctx context.Context) (string, error)
}

type ConfigError struct {
	Path string
	Err  error
}

func (e *ConfigError) Error() string { return e.Path + ": " + e.Err.Error() }

func (e *ConfigError) Unwrap() error { return e.Err }

type Registry[T any] struct {
	o    RegistryOptions[T]
	kind string

	mu      sync.Mutex
	entries map[string]*Child[T]

	stops sync.WaitGroup
}

type RegistryOptions[T any] struct {
	Kind                   Kind
	Component              string
	Children               *Supervisor
	Configs                Configs
	NotFound               error
	Now                    func() time.Time
	ReadyTimeout, StopWait time.Duration
	Backoff                Backoff

	Publish func(c *Child[T], st Status, msg error)
	Up      func(c *Child[T])
	Down    func(c *Child[T], msg error, again bool)
	OnStop  func(ctx context.Context, c *Child[T]) func(ctx context.Context)
}

type Child[T any] struct {
	ID      string
	Name    string
	Source  string
	Started time.Time
	Log     *slog.Logger
	Own     T

	unit atomic.Pointer[Unit]

	status    Status
	pid       int
	err       error
	lastErr   string
	lastErrAt time.Time
	everUp    bool
	stopping  bool
	restart   bool
}

type Report struct {
	Status  Status
	PID     int
	Err     error
	Restart bool
}

type Launch struct {
	Spec  Spec
	Ready func(ctx context.Context) (bool, error)
	Late  func(within time.Duration) i18n.Text
	Check func(ctx context.Context) error
}

func NewRegistry[T any](o RegistryOptions[T]) *Registry[T] {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Registry[T]{o: o, kind: string(o.Kind), entries: map[string]*Child[T]{}}
}

func (c *Child[T]) Unit() *Unit { return c.unit.Load() }

func (r *Registry[T]) Config(ctx context.Context) (config, password string, err error) {
	path := r.o.Configs.Path()
	password, err = r.o.Configs.ChildPassword(ctx)
	if err != nil {
		return "", "", &ConfigError{Path: path, Err: err}
	}
	return path, password, nil
}

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
			id = ids.Hex(idBytes)
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

func (r *Registry[T]) All() []*Child[T] {
	return r.sorted(func(*Child[T]) bool { return true })
}

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

func (r *Registry[T]) down(c *Child[T], d Down) bool {
	r.mu.Lock()
	if c.stopping {
		r.mu.Unlock()
		return false
	}
	var msg error
	if c.lastErr != "" && (!d.WasUp || r.o.Now().Sub(c.lastErrAt) <= freshErr) {
		msg = errors.New(c.lastErr)
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

func (r *Registry[T]) WaitStops(ctx context.Context, d time.Duration) bool {
	return syncx.Wait(ctx, &r.stops, d)
}

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

func (r *Registry[T]) RC(id string) *RC {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.entries[id]
	if c == nil || c.Unit() == nil || c.stopping || c.status != StatusRunning {
		return nil
	}
	return c.Unit().RC()
}

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

func Closing(ctx context.Context, err error) bool {
	return errors.Is(err, ErrClosed) || ctx.Err() != nil
}

func clipped(err error) error {
	if text := err.Error(); len(text) > maxErrorText || !utf8.ValidString(text) {
		return errors.New(clip(text, maxErrorText))
	}
	return err
}

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
