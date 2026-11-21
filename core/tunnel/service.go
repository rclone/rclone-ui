// Package tunnel runs the remote tunnel. While the tunnel is on, the app runs a `rclone tunnel`
// child process (package tunnelcmd) that uses the config file and random rc credentials.
// The child runs rclone's rc server, with cloudflared in front of it on a trycloudflare.com
// address. The pairing QR code holds {url, user, pass}, which the mobile app reads.
//
// The tunnel exposes rclone's full rc API, deliberately unfiltered. Whatever the phone starts
// (transfers, mounts, serves) runs in that child process, and ends with the tunnel.
package tunnel

import (
	"context"
	"database/sql"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/tunnel/tunnelcmd"
)

const (
	// startWait limits how long a start can take: the child's rc server must be up and
	// Cloudflare must be serving it.
	startWait = 60 * time.Second
	stopWait  = 15 * time.Second
	// restoreKey is set in the app meta by an update's shutdown while the tunnel is on. The
	// app's next run turns the tunnel on again, with new credentials and a new QR code.
	restoreKey = "tunnel.restore"
)

type State string

const (
	StateOff        State = "off"
	StateStarting   State = "starting"
	StateOn         State = "on"
	StateRestarting State = "restarting" // the tunnel's process exited and is starting again
)

// Status is the tunnel as the Mobile & Remote Control window sees it. URL, User and Pass are set
// while it is on.
type Status struct {
	State State
	URL   string
	User  string
	Pass  string
	// Err explains why the last start failed, or why the tunnel went down. The API gives it in
	// the app's language.
	Err error
}

// Configs provides what the tunnel needs from the config file: its path and its password.
type Configs interface {
	Path() string
	ChildPassword(ctx context.Context) (string, error)
}

type Options struct {
	DB       *db.DB
	Bus      *bus.Bus
	Children *children.Supervisor
	Configs  Configs

	// spawned runs once a start's child is started, before its unit is stored. Tests use it.
	spawned func(*children.Unit)
}

// errStopping is returned for a start that the app's shutdown refused or ended.
var errStopping = children.TextError(
	// i18n: Why the remote tunnel did not start.
	i18n.M("the app is shutting down"), nil)

// Service runs the tunnel. There is one per core.
type Service struct {
	o   Options
	log *slog.Logger
	// closing ends when the core's shutdown begins. A start in progress then stops waiting for
	// its address, because it holds op, which the shutdown's stop needs. No start begins after
	// that.
	closing context.Context
	close   context.CancelFunc

	op sync.Mutex // allows one start, stop or restart at a time

	mu     sync.Mutex
	unit   *children.Unit
	status Status
	url    chan string // the address the child logs once it is served, sent to the waiting start
	// cancelStart ends the start in progress, and is nil when there is none. It lets a Stop
	// avoid waiting for the start to give up, which takes a minute when the network is down.
	cancelStart context.CancelFunc
}

func New(o Options) *Service {
	closing, close := context.WithCancel(context.Background())
	return &Service{o: o, log: logs.Logger(logs.CompTunnel, ""), closing: closing, close: close, status: Status{State: StateOff}}
}

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Start turns the tunnel on and returns once it has an address, or with the reason it has none.
// Starting a tunnel that is already on returns its status. A Stop in the meantime ends the
// start, which then returns the tunnel as off, without an error.
func (s *Service) Start(ctx context.Context) (Status, error) {
	s.op.Lock()
	defer s.op.Unlock()
	return s.start(ctx)
}

func (s *Service) start(ctx context.Context) (Status, error) {
	// Don't use the request's context. If a client goes away during the start, the tunnel keeps
	// starting, and the Mobile & Remote Control window learns how it ends. Only a Stop or the
	// core's shutdown ends it.
	ctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	// Do the check and set the state under one lock. That way a shutdown either refuses this
	// start, or sees it starting and records it for after an update's restart (Shutdown).
	s.mu.Lock()
	if s.closing.Err() != nil {
		st := s.status
		s.mu.Unlock()
		return st, errStopping
	}
	if s.unit != nil {
		st := s.status
		s.mu.Unlock()
		return st, nil
	}
	s.status = Status{State: StateStarting}
	s.cancelStart = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.cancelStart = nil
		s.mu.Unlock()
	}()
	defer context.AfterFunc(s.closing, cancel)()
	s.publish()

	config := s.o.Configs.Path()
	password, err := s.o.Configs.ChildPassword(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return s.ended()
		}
		// i18n: Why the remote tunnel did not start. The value is the keychain's error.
		return s.failed(children.TextError(i18n.M("the config's password: %w", err), err))
	}
	urls := make(chan string, 1)
	s.mu.Lock()
	s.url = urls
	s.mu.Unlock()

	u, err := s.o.Children.Start(children.Spec{
		Name: "tunnel", Kind: children.KindTunnel,
		Rclone:     []string{"tunnel"},
		ConfigPath: config, ConfigPassword: password,
		Component: logs.CompTunnel, Subcomponent: "rclone",
		Parse:     s.lines(),
		QuietStop: true,
		Ready:     s.published,
		OnUp:      func(u *children.Unit) { s.up(u) },
		OnDown:    func(_ *children.Unit, d children.Down) bool { return s.down(d) },
	})
	if err != nil {
		return s.failed(err)
	}
	if s.o.spawned != nil {
		s.o.spawned(u)
	}
	s.mu.Lock()
	// A child that failed at once has already gone through down, which ended the start. Its unit
	// is finished, and storing it would make the tunnel look like it is on.
	if s.status.State != StateOff {
		s.unit = u
	}
	s.mu.Unlock()

	wctx, wcancel := context.WithTimeout(ctx, startWait)
	defer wcancel()
	for {
		st := s.Status()
		switch st.State {
		case StateOn:
			return st, nil
		case StateOff:
			return st, st.Err
		}
		select {
		case <-wctx.Done():
			_ = s.stop(context.WithoutCancel(ctx))
			if ctx.Err() != nil {
				return s.ended()
			}
			// i18n: Why the remote tunnel did not start.
			return s.failed(children.TextError(i18n.M("the tunnel had no address in time"), nil))
		case <-u.Done():
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// ended finishes a start that a Stop or the core's shutdown cut short.
func (s *Service) ended() (Status, error) {
	if s.closing.Err() != nil {
		return s.failed(errStopping)
	}
	s.mu.Lock()
	s.status = Status{State: StateOff}
	st := s.status
	s.mu.Unlock()
	s.publish()
	s.log.Info("the tunnel was turned off while it started")
	return st, nil
}

// failed finishes a start that couldn't continue.
func (s *Service) failed(err error) (Status, error) {
	s.mu.Lock()
	s.status = Status{State: StateOff, Err: err}
	st := s.status
	s.mu.Unlock()
	s.publish()
	s.log.Error("the tunnel did not start", "error", err)
	return st, err
}

// published is the child's readiness check. The child is ready once it has logged the address
// that Cloudflare serves it on.
func (s *Service) published(ctx context.Context, _ *children.Process) error {
	s.mu.Lock()
	urls := s.url
	s.mu.Unlock()
	select {
	case url := <-urls:
		s.mu.Lock()
		s.status.URL = url
		s.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// up runs when the child is running and Cloudflare is serving it.
func (s *Service) up(u *children.Unit) {
	user, pass := u.RC().Credentials()
	s.mu.Lock()
	s.status.State, s.status.User, s.status.Pass, s.status.Err = StateOn, user, pass, nil
	url := s.status.URL
	s.mu.Unlock()
	s.publish()
	s.log.Info("the tunnel is on", "url", url)
}

// down runs when the child exited. If the child never came up, the tunnel ends. Otherwise it
// starts again on a new address, because quick tunnels get a new one each time.
func (s *Service) down(d children.Down) bool {
	msg := d.Err
	s.mu.Lock()
	if !d.WasUp && s.status.State == StateStarting {
		s.status = Status{State: StateOff, Err: msg}
		s.unit = nil
		s.mu.Unlock()
		s.publish()
		return false
	}
	s.status = Status{State: StateRestarting, Err: msg}
	s.url = make(chan string, 1)
	s.mu.Unlock()
	s.publish()
	s.log.Warn("the tunnel went down; starting it again", "error", msg, "in", d.Delay)
	return true
}

// lines reads the child's stderr, which has rclone's JSON lines (msg) and cloudflared's lines
// (message). It passes on the address from the line that says the tunnel is being served.
func (s *Service) lines() logs.LineParser {
	rclone := logs.RcloneChild(logs.CompTunnel, "rclone")
	edge := logs.PlainLines(logs.CompTunnel, "cloudflared")
	return func(line string, stream logs.Stream, now time.Time) (logs.Record, bool) {
		if url := tunnelcmd.ServedURL(line); url != "" {
			s.mu.Lock()
			urls := s.url
			s.mu.Unlock()
			select {
			case urls <- url:
			default:
			}
		}
		if strings.Contains(line, `"message":`) && !strings.Contains(line, `"msg":`) {
			return edge(line, stream, now)
		}
		return rclone(line, stream, now)
	}
}

// Stop turns the tunnel off. It stops the child, and the credentials go away with it. A start in
// progress is ended first, instead of waiting for it to give up.
func (s *Service) Stop(ctx context.Context) error {
	s.mu.Lock()
	if s.cancelStart != nil {
		s.cancelStart()
	}
	s.mu.Unlock()
	s.op.Lock()
	defer s.op.Unlock()
	return s.stop(ctx)
}

func (s *Service) stop(ctx context.Context) error {
	s.mu.Lock()
	u := s.unit
	s.unit = nil
	s.mu.Unlock()
	if u == nil {
		return nil
	}
	u.Leave()
	sctx, cancel := context.WithTimeout(ctx, stopWait)
	defer cancel()
	err := u.Stop(sctx)
	s.mu.Lock()
	s.status = Status{State: StateOff}
	s.mu.Unlock()
	s.publish()
	s.log.Info("the tunnel is off")
	return err
}

// Shutdown is the tunnel's part of the core's shutdown, and runs before the children stop. A
// start in progress ends at once, because an offline tunnel would hold up the shutdown for a
// minute, and no new start begins. If an update's restart happens while the tunnel is on,
// starting or restarting, Shutdown records it so that the app's next run turns it on again.
func (s *Service) Shutdown(ctx context.Context, restart bool) {
	// Read the state together with the close. A start in progress ends because of the close,
	// and removes its unit. A stop in progress has already removed it, so the tunnel is off.
	s.mu.Lock()
	s.close()
	on := s.unit != nil || s.status.State == StateStarting
	s.mu.Unlock()
	if restart && on {
		if err := s.o.DB.Write(ctx, func(tx *sql.Tx) error { return db.SetMeta(ctx, tx, restoreKey, "1") }); err != nil {
			s.log.Error("could not record the tunnel for after the restart", "error", err)
		}
	}
	_ = s.Stop(ctx)
}

// Boot turns the tunnel on again when the app's previous run stopped for an update while the
// tunnel was on.
func (s *Service) Boot(ctx context.Context) {
	v, ok, err := s.o.DB.GetMeta(ctx, restoreKey)
	if err != nil || !ok || v != "1" {
		return
	}
	if err := s.o.DB.Write(ctx, func(tx *sql.Tx) error { return db.SetMeta(ctx, tx, restoreKey, "") }); err != nil {
		s.log.Error("could not clear the tunnel's restore", "error", err)
	}
	if _, err := s.Start(ctx); err != nil {
		s.log.Error("the tunnel did not come back after the restart", "error", err)
	}
}

func (s *Service) publish() {
	if s.o.Bus == nil {
		return
	}
	st := s.Status()
	s.o.Bus.Publish(bus.TunnelChanged, bus.TunnelChangedData{State: string(st.State), Error: i18n.Localize(st.Err)})
}
