// Package serves runs the app's serves. Each serve is a `rcui serve <type> …` child process that
// uses its own config file and is supervised by core/children. Its address is known before it
// starts, because the app picks the port when the form asks for port 0. A serve is ready once
// its address accepts a connection. When it crashes, it is restarted with backoff, and
// serve.failed is sent once per streak of failures. After a planned restart or a crash of the
// app, it is started again.
//
// A children.Registry handles what serves and mounts have in common. This package adds the
// part specific to serves: the address.
package serves

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

const (
	readyTimeout = 30 * time.Second // counted from the child's start
	dialWait     = 300 * time.Millisecond
	stopWait     = 30 * time.Second // how long a stop waits: 10 s grace, then the kill
)

// ErrNotFound is returned for a serve that isn't in the registry (stopped, failed, or never
// started).
var ErrNotFound = errs.NotFound("serve", "This serve is not running any more.")

// Options configures the service.
type Options struct {
	Bus      *bus.Bus
	Notifier notifications.Notifier
	Children *children.Supervisor
	// Configs provides the config file and the password for a child.
	Configs children.Configs
	// Executable is the path used for the app's own metadata mapper ("" means os.Executable()).
	Executable string
	Now        func() time.Time // default time.Now
	// Secrets stores a serve's credentials (its password and auth keys) by child id, for as long
	// as the serve may start again after a restart (core/keychain). children.json never holds
	// them. When Secrets is nil, nothing is stored, and a serve with credentials doesn't come
	// back after a restart.
	Secrets Secrets

	// Tests replace these. Zero values mean the real ones.
	readyTimeout time.Duration
	stopWait     time.Duration
	backoff      children.Backoff
}

// Secrets stores a serve's credentials until a restart (core/keychain).
type Secrets interface {
	Get(account string) (string, error)
	Set(account, secret string) error
	Delete(account string) error
}

// Service is the serve registry. There is one per process.
type Service struct {
	o   Options
	log *slog.Logger
	reg *children.Registry[serve]
}

// serve holds the serve-specific data of a child in the registry.
type serve struct {
	kind, addr string
	addrs      []string             // every address it listens on, addr first
	args       operations.ServeArgs // the serve's form, with its address resolved
	secret     bool                 // the form has credentials, stored in Secrets for a restart
	streak     *notifications.Streak
}

type child = children.Child[serve]

// meta is what children.json stores about a serve so it can be started again after a restart.
// It holds the form with the serve's address, so the serve comes back where its clients expect
// it. It doesn't hold the credentials, which are stored in Secrets under the serve's id. The
// Secrets field says whether there are any. The config file is stored in the record itself.
type meta struct {
	Args    operations.ServeArgs `json:"args"`
	Secrets bool                 `json:"secrets,omitempty"`
}

// secretAccount returns the keychain account for the credentials of serve id.
func secretAccount(id string) string { return "serve:" + id }

// New creates the service.
func New(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Executable == "" {
		o.Executable, _ = os.Executable()
	}
	if o.readyTimeout == 0 {
		o.readyTimeout = readyTimeout
	}
	if o.stopWait == 0 {
		o.stopWait = stopWait
	}
	s := &Service{o: o, log: logs.Logger(logs.CompServes, "")}
	s.reg = children.NewRegistry(children.RegistryOptions[serve]{
		Kind: children.KindServe, Component: logs.CompServes, Children: o.Children, Configs: o.Configs,
		NotFound: ErrNotFound, Now: o.Now,
		ReadyTimeout: o.readyTimeout, StopWait: o.stopWait, Backoff: o.backoff,
		Publish: s.publish, Up: s.up, Down: s.down, OnStop: s.onStop,
	})
	return s
}

// Start starts a serve from the Serve page's form. It returns at once
// with the address the serve will listen on, with port 0 replaced by the picked port. The serve
// is then starting, and serves.changed reports when it runs or fails.
func (s *Service) Start(ctx context.Context, a operations.ServeArgs) (Serve, error) {
	return s.start(ctx, a, "")
}

func (s *Service) start(ctx context.Context, a operations.ServeArgs, id string) (Serve, error) {
	config, password, err := s.reg.Config(ctx)
	if err != nil {
		return Serve{}, err
	}
	env := operations.ServeEnv{Exe: s.o.Executable}
	cmd, err := operations.ServeCommand(a, env)
	if err != nil {
		return Serve{}, err
	}
	if resolved, err := resolvePort(cmd.Addr); err != nil {
		return Serve{}, err
	} else if resolved != cmd.Addr {
		a.Addr = resolved
		if cmd, err = operations.ServeCommand(a, env); err != nil {
			return Serve{}, err
		}
	}
	a.Addr = cmd.Addr
	if root := s.o.Children.CacheDir(); root != "" {
		cmd.Args = append(cmd.Args, "--cache-dir="+cacheFolder(root, cmd.Addr))
	}
	kept, secrets, err := operations.ServeSecrets(a)
	if err != nil {
		return Serve{}, err
	}
	raw, err := json.Marshal(meta{Args: kept, Secrets: secrets != nil})
	if err != nil {
		return Serve{}, err
	}
	name := a.Type + ":" + cmd.Addr
	c := &child{
		Name: name, Source: a.Source, Started: s.o.Now(), Log: logs.Logger(logs.CompServes, name),
		Own: serve{kind: a.Type, addr: cmd.Addr, addrs: cmd.Addrs, args: a, secret: secrets != nil,
			streak: notifications.NewStreak(s.o.Notifier, notifications.NotificationEventServeFailed, nil)},
	}
	if err := s.reg.Reserve(c, id, func(others []*child) error {
		for _, o := range others {
			if addr, ok := clash(c.Own.listens(), o.Own.listens()); ok {
				return errs.Errorf("A serve of Rclone UI listens on %s already.", addr)
			}
		}
		return nil
	}); err != nil {
		return Serve{}, err
	}
	if answers(ctx, cmd.Addr) {
		s.reg.Drop(c)
		return Serve{}, foreign(cmd.Addr)
	}
	if secrets != nil {
		s.keepSecrets(ctx, c, secrets)
	}
	if err := s.reg.Spawn(c, children.Launch{
		Spec: children.Spec{Rclone: cmd.Args, SecretEnv: cmd.Env, Secrets: cmd.Secrets, ConfigPassword: password, Addr: cmd.Addr, Meta: raw},
		// The serve is ready once its address accepts a connection.
		Ready: func(ctx context.Context) (bool, error) { return answers(ctx, cmd.Addr), nil },
		Late: func(d time.Duration) i18n.Text {
			// i18n: Why a serve failed to start. The values are its address and how long the app waited, as in "30s".
			return i18n.M("%s did not answer within %s", cmd.Addr, d)
		},
		// Whatever answers before the process starts is another program. A restart after a
		// crash refuses it as a start does, instead of taking its answer for the serve's.
		Check: func(ctx context.Context) error {
			if answers(ctx, cmd.Addr) {
				return foreign(cmd.Addr)
			}
			return nil
		},
	}); err != nil {
		// For a serve from the previous run that failed to start because the app is shutting
		// down, the record stays, so its credentials must stay too.
		if id == "" || !children.Closing(ctx, err) {
			s.forgetSecrets(c)
		}
		return Serve{}, err
	}
	c.Log.InfoContext(ctx, "starting a serve", "source", a.Source, "id", c.ID, "config", config)
	return s.view(c), nil
}

// foreign is the refusal for an address that another program already listens on.
func foreign(addr string) error { return errs.Errorf("Something already listens on %s.", addr) }

// cacheFolder returns a serve's own cache folder, <cache>/serves/<16 hex of its address>. Only
// one running serve uses it, because no two serves share an address, and its guard lets its VFS
// cache use it (childproc). The folder stays the same for the same address, so what a serve
// keeps there outlives it. That includes uploads its VFS still had queued, which the next serve
// of the same source at that address sends, and an sftp serve's host keys, which clients know
// by host and port.
func cacheFolder(root, addr string) string {
	sum := sha256.Sum256([]byte(addr))
	return filepath.Join(root, "serves", hex.EncodeToString(sum[:8]))
}

// resolvePort picks a free port for an address that asks for port 0, so the address is known
// before the child starts. Anything that isn't host:port, such as a unix socket, is left as it
// is.
func resolvePort(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port != "0" {
		return addr, nil
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return "", fmt.Errorf("no free port on %s: %w", addr, err)
	}
	defer func() { _ = ln.Close() }()
	_, picked, _ := net.SplitHostPort(ln.Addr().String())
	return net.JoinHostPort(host, picked), nil
}

// listens returns every address that the serve listens on. A serve recorded before it kept the
// whole list has only its first address.
func (v serve) listens() []string {
	if len(v.addrs) == 0 {
		return []string{v.addr}
	}
	return v.addrs
}

// clash returns the first of mine that clashes with one of theirs. Every address of both serves
// is compared, because a serve can listen on several.
func clash(mine, theirs []string) (string, bool) {
	for _, a := range mine {
		for _, b := range theirs {
			if sameListener(a, b) {
				return a, true
			}
		}
	}
	return "", false
}

// sameListener reports whether two serves' addresses clash. Two serves on the same port clash
// whatever their hosts, so a serve's port always tells it apart from the app's other serves. A
// unix socket is compared by its path.
func sameListener(a, b string) bool {
	if a == b {
		return true
	}
	_, pa, errA := net.SplitHostPort(a)
	_, pb, errB := net.SplitHostPort(b)
	// Port 0 asks for any free port, so it never clashes.
	return errA == nil && errB == nil && pa == pb && pa != "0"
}

// dialTarget returns where to reach a listening address. An address on all interfaces is reached
// through loopback, and a unix socket as a unix socket.
func dialTarget(addr string) (network, address string) {
	if path, ok := strings.CutPrefix(addr, "unix://"); ok {
		return "unix", path
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "tcp", addr
	}
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "tcp", net.JoinHostPort(host, port)
}

// answers reports whether the address accepts a connection right now.
func answers(ctx context.Context, addr string) bool {
	network, address := dialTarget(addr)
	d := net.Dialer{Timeout: dialWait}
	c, err := d.DialContext(ctx, network, address)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// up runs when the serve's address accepts connections.
func (s *Service) up(c *child) {
	c.Own.streak.Up()
	c.Log.Info("serving", "source", c.Source, "id", c.ID)
}

// down runs when the child exited, or didn't accept connections in time. serve.failed is sent
// once per streak of failures. When a first start fails, the serve is over, and nothing starts
// it again.
func (s *Service) down(c *child, msg error, again bool) {
	c.Own.streak.Failed(context.Background(), notifications.ServeFailed{Type: c.Own.kind, Addr: c.Own.addr, Source: c.Source, Error: i18n.Localize(msg)})
	if !again {
		s.forgetSecrets(c)
	}
}

// onStop handles a user's stop, which also ends the serve once its child has exited.
func (s *Service) onStop(_ context.Context, c *child) func(context.Context) {
	return func(context.Context) { s.forgetSecrets(c) }
}

// keepSecrets stores c's credentials for a restart. When they can't be stored, the serve still
// runs, but it won't be started again after a restart, because Boot refuses to serve without
// them.
func (s *Service) keepSecrets(ctx context.Context, c *child, secrets json.RawMessage) {
	if s.o.Secrets == nil {
		return
	}
	if err := s.o.Secrets.Set(secretAccount(c.ID), string(secrets)); err != nil {
		c.Log.WarnContext(ctx, "could not keep the serve's credentials; it will not start again after a restart", "error", err)
	}
}

// forgetSecrets deletes c's credentials, if it has any, because it won't start again.
func (s *Service) forgetSecrets(c *child) {
	if c.Own.secret {
		s.forgetAccount(c.ID)
	}
}

// forgetAccount deletes the credentials stored for serve id.
func (s *Service) forgetAccount(id string) {
	if s.o.Secrets == nil {
		return
	}
	if err := s.o.Secrets.Delete(secretAccount(id)); err != nil {
		s.log.Warn("could not remove a serve's credentials", "id", id, "error", err)
	}
}

// secretsOf returns r's form with its credentials restored from Secrets.
func (s *Service) secretsOf(r children.Record, a operations.ServeArgs) (operations.ServeArgs, error) {
	if s.o.Secrets == nil {
		return a, errors.New("no keychain to read them from")
	}
	v, err := s.o.Secrets.Get(secretAccount(r.ID))
	if err != nil {
		return a, err
	}
	return operations.WithServeSecrets(a, json.RawMessage(v))
}

// List returns the registry, oldest first.
func (s *Service) List() []Serve {
	all := s.reg.All()
	out := make([]Serve, len(all))
	for i, c := range all {
		out[i] = s.view(c)
	}
	return out
}

// view returns c as the pages see it.
func (s *Service) view(c *child) Serve {
	r, own := s.reg.View(c)
	return Serve{
		ID: c.ID, Type: own.kind, Source: c.Source, Addr: own.addr, Args: own.args,
		PID: r.PID, State: r.Status, Error: r.Err, Restart: r.Restart,
	}
}

// Stop stops a serve. It sends SIGTERM, waits 10 s, then sends SIGKILL (on Windows, it kills the
// process). The stop keeps going if ctx ends first, or if the child takes longer than stopWait
// to exit. In those cases Stop returns the error, and serves.changed reports when the serve has
// stopped.
func (s *Service) Stop(ctx context.Context, id string) error { return s.reg.Stop(ctx, id) }

// StopAll stops every serve, as the launcher's "Stop All" does. It returns how many it stopped,
// and joins the errors of the serves that couldn't be stopped.
func (s *Service) StopAll(ctx context.Context) (int, error) { return s.reg.StopAll(ctx) }

// RemotesChanged flags the serves that uses picks by their source, because a remote they serve
// has changed. The page shows "Restart to apply" until they start again.
func (s *Service) RemotesChanged(uses func(source string) bool) {
	s.reg.RemotesChanged(func(c *child) bool { return uses(c.Source) })
}

// RC returns a running serve's rc client for the VFS actions, or nil when it isn't running.
func (s *Service) RC(id string) *children.RC { return s.reg.RC(id) }

// Boot starts the serves that were running before, each with its own address.
// It runs once at start, after the supervisor. These serves are the pending records in
// children.json, kept by a planned restart or left by a previous run that crashed while they
// were running. A failure is logged and notified, and the other serves still start. A shutdown
// during Boot ends it quietly.
func (s *Service) Boot(ctx context.Context) {
	s.reg.Resume(ctx, func(r children.Record) error {
		var m meta
		if err := json.Unmarshal(r.Meta, &m); err != nil || m.Args.Type == "" {
			s.log.WarnContext(ctx, "a serve of the previous run cannot be started again: its arguments are not recorded", "addr", r.Addr)
			return children.ErrNotRecorded
		}
		if m.Secrets {
			// Never start without the credentials, because that would serve with no password.
			a, err := s.secretsOf(r, m.Args)
			if err != nil {
				s.log.WarnContext(ctx, "a serve of the previous run cannot be started again: its credentials are not kept", "addr", r.Addr, "error", err)
				s.forgetAccount(r.ID)
				return children.ErrNotRecorded
			}
			m.Args = a
		}
		_, err := s.start(ctx, m.Args, r.ID)
		if err != nil && m.Secrets && !children.Closing(ctx, err) {
			s.forgetAccount(r.ID) // the record is removed too
		}
		if err != nil && !children.Closing(ctx, err) {
			s.log.ErrorContext(ctx, "could not start a serve of the previous run again", "source", m.Args.Source, "addr", r.Addr, "error", err)
			s.o.Notifier.Notify(ctx, notifications.NotificationEventServeFailed,
				notifications.ServeFailed{Type: m.Args.Type, Addr: r.Addr, Source: m.Args.Source, Error: i18n.Localize(err)})
		}
		return err
	})
}

// Shutdown runs during the core's shutdown, once every child has stopped. A quit (restore is
// false) brings no serve back, so their credentials are deleted. An update's restart keeps them
// for Boot.
func (s *Service) Shutdown(restore bool) {
	if restore {
		return
	}
	for _, c := range s.reg.All() {
		s.forgetSecrets(c)
	}
}

// Busy returns what a quit or an update would stop: every serve, and whether it comes back.
// restore is true for an update, whose restart brings every serve back.
func (s *Service) Busy(restore bool) []BusyServe {
	out := []BusyServe{}
	for _, c := range s.reg.Live() {
		out = append(out, BusyServe{ID: c.ID, Type: c.Own.kind, Source: c.Source, Addr: c.Own.addr, Back: restore})
	}
	return out
}

// publish sends serves.changed for a serve, with its address and its error in the app's language.
func (s *Service) publish(c *child, st children.Status, msg error) {
	if s.o.Bus != nil {
		s.o.Bus.Publish(bus.ServesChanged, bus.ServesChangedData{ID: c.ID, State: string(st), Addr: c.Own.addr, Error: i18n.Localize(msg)})
	}
}
