// Package mounts runs the app's mounts. Each mount is a `rcui nfsmount|mount|cmount …` child
// process that uses its own config file and is supervised by core/children. A mount is ready once
// the OS mount table lists it. When it crashes, it is restarted with backoff, and mount.failed
// is sent once per streak of failures. When a user stops a mount, its queued uploads are kept
// (stopped_mounts).
//
// The package also stores each automount, and after a planned restart or a crash
// of the app, it starts again what was running. A children.Registry handles what mounts and
// serves have in common. This package adds the parts specific to mounts: the mount point and the
// cache folder.
package mounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/freeport"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

const (
	readyTimeout = 30 * time.Second // counted from the child's start, including its NewFs
	queueWait    = 5 * time.Second  // how long a stop waits to read the upload queue
	stopWait     = 30 * time.Second // how long a stop waits: 10 s grace, the kill and the cleanup
)

// ErrNotFound is returned for a mount that isn't in the registry (stopped, failed, or never
// started).
var ErrNotFound = errs.NotFound("mount", "This mount is not running any more.")

// unsupported is the error for a mount started on a computer that can't mount. sup explains why.
func unsupported(sup Support) error {
	var why any = sup.Reason
	if !sup.reason.IsZero() {
		why = sup.reason
	}
	// i18n: The value is the reason, a sentence such as "WinFsp is not installed."
	return errs.Unsupported("mount", "This computer cannot mount: %s", why)
}

// listFunc lists the folder dir in the Fs root, up to the end of the first page, to check that
// the source responds. Tests replace it through Options.list.
type listFunc func(ctx context.Context, root, dir string) error

// statFunc reports whether remote exists in the Fs root, and whether it is a folder. It returns
// err when the source didn't respond. Tests replace it through Options.stat.
type statFunc func(ctx context.Context, root, remote string) (found, isDir bool, err error)

// Options configures the service.
type Options struct {
	DB       *db.DB
	Bus      *bus.Bus
	Notifier notifications.Notifier
	Children *children.Supervisor
	// Configs provides the config file and the password for a child.
	Configs children.Configs
	// RemoteNames returns the remotes in the config, as the store has them.
	RemoteNames func() []string
	// CacheRoot is rclone's cache folder, <data>/cache. A mount's VFS cache is
	// <CacheRoot>/vfs/<16 hex>.
	CacheRoot string
	// Executable is the app's own executable, which mounts use as their metadata mapper, and next
	// to which the WinFsp installer is ("" means os.Executable()).
	Executable string
	// PointChanged is called with a mount point whose mount started, failed, restarted or
	// stopped, before mounts.changed is published. The listings cache forgets the mount point
	// and the folder that holds it, so the panels that list them again see the change.
	PointChanged func(mountPoint string)
	Now          func() time.Time // default time.Now

	// Tests replace these. Zero values mean the real ones.
	goos         string
	mounted      func(mountPoint string) (bool, error)
	drives       func() uint32 // Windows: the drives in use, bit 0 for A:
	unmount      func(ctx context.Context, mountPoint string) error
	command      func(operations.MountArgs, operations.MountEnv) (operations.Mount, error)
	list         listFunc
	stat         statFunc
	support      func() Support
	readyTimeout time.Duration
	stopWait     time.Duration
	backoff      children.Backoff
	probeDelays  []time.Duration
}

// Service is the mount registry. There is one per process.
type Service struct {
	o   Options
	log *slog.Logger
	reg *children.Registry[mount]
}

// mount holds the mount-specific data of a child in the registry.
type mount struct {
	args       operations.MountArgs
	mountPoint string // for a Windows `*`, the drive that reserve picked
	folder     string // the mount's VFS cache folder
	automount  bool   // started as an automount, so its cache folder is kept
	streak     *notifications.Streak
}

type child = children.Child[mount]

// meta is what children.json stores about a mount so it can be started again after a restart.
// The config file is stored in the record itself.
type meta struct {
	Args      operations.MountArgs `json:"args"`
	Automount bool                 `json:"automount,omitempty"`
}

// New creates the service.
func New(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Executable == "" {
		o.Executable, _ = os.Executable()
	}
	if o.goos == "" {
		o.goos = runtime.GOOS
	}
	if o.mounted == nil {
		o.mounted = mounted
	}
	if o.drives == nil {
		o.drives = drivesInUse
	}
	if o.unmount == nil {
		o.unmount = children.Unmount
	}
	if o.command == nil {
		o.command = operations.MountCommand
	}
	if o.list == nil {
		o.list = listFirstPage
	}
	if o.stat == nil {
		o.stat = statEntry
	}
	if o.RemoteNames == nil {
		o.RemoteNames = func() []string { return nil }
	}
	if o.support == nil {
		o.support = CheckSupport
	}
	if o.readyTimeout == 0 {
		o.readyTimeout = readyTimeout
	}
	if o.stopWait == 0 {
		o.stopWait = stopWait
	}
	if o.probeDelays == nil {
		// The automount probe retries 7 times, doubling from 1 s up to at most 15 s.
		o.probeDelays = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
			15 * time.Second, 15 * time.Second, 15 * time.Second}
	}
	s := &Service{o: o, log: logs.Logger(logs.CompMounts, "")}
	s.reg = children.NewRegistry(children.RegistryOptions[mount]{
		Kind: children.KindMount, Component: logs.CompMounts, Children: o.Children, Configs: o.Configs,
		NotFound: ErrNotFound, Now: o.Now,
		ReadyTimeout: o.readyTimeout, StopWait: o.stopWait, Backoff: o.backoff,
		Publish: s.publish, Up: s.up, Down: s.down, OnStop: s.onStop,
	})
	return s
}

// Start starts a mount from the Mount page's form. It returns at once
// with the mount in the starting state, and mounts.changed reports when it runs or fails.
func (s *Service) Start(ctx context.Context, a operations.MountArgs) (Mount, error) {
	return s.start(ctx, a, startOpts{})
}

type startOpts struct {
	id        string // a mount started again after a restart keeps its id from children.json
	automount bool
}

func (s *Service) start(ctx context.Context, a operations.MountArgs, so startOpts) (Mount, error) {
	if sup := s.o.support(); !sup.Supported {
		return Mount{}, unsupported(sup)
	}
	config, password, err := s.reg.Config(ctx)
	if err != nil {
		return Mount{}, err
	}
	port := 0 // on macOS, the port nfsmount serves on (recorded for the cleanup at the next start)
	if s.o.goos == "darwin" {
		addr, err := freeport.Loopback()
		if err != nil {
			return Mount{}, fmt.Errorf("no free port for the NFS mount: %w", err)
		}
		port = addr.Port
	}
	m, err := s.o.command(a, s.env(port))
	if err != nil {
		return Mount{}, err
	}
	c := &child{Source: a.Source, Started: s.o.Now(), Own: mount{
		args: a, mountPoint: m.MountPoint, folder: m.CacheDir, automount: so.automount,
		streak: notifications.NewStreak(s.o.Notifier, notifications.NotificationEventMountFailed, nil),
	}}
	// From here on, any refusal, including from the mount point checks, counts as the mount
	// failing and sends a notification.
	failed := func(err error) (Mount, error) {
		s.o.Notifier.Notify(ctx, notifications.NotificationEventMountFailed,
			notifications.MountFailed{Source: a.Source, Destination: m.MountPoint, Error: i18n.Localize(err)})
		return Mount{}, notifiedError{err}
	}
	if err := s.reserve(c, so.id); err != nil {
		return failed(err)
	}
	m = onDrive(m, c.Own.mountPoint)
	c.Name, c.Log = m.MountPoint, logs.Logger(logs.CompMounts, m.MountPoint)
	windows := s.o.goos == "windows"
	if !windows {
		// Never look inside a mount point that is already mounted, because a dead NFS mount hangs
		// whoever does.
		if ok, err := s.o.mounted(m.MountPoint); err == nil && ok {
			s.reg.Drop(c)
			return failed(errs.Errorf("Something is already mounted at %s.", m.MountPoint))
		}
	}
	if err := prepareMountPoint(m.MountPoint, windows); err != nil {
		s.reg.Drop(c)
		return failed(err) // a usererr (prepareMountPoint)
	}
	raw, err := json.Marshal(meta{Args: a, Automount: so.automount})
	if err != nil {
		s.reg.Drop(c)
		return Mount{}, err
	}
	err = s.reg.Spawn(c, children.Launch{
		Spec: children.Spec{Rclone: m.Args, ConfigPassword: password, MountPoint: m.MountPoint, NFSPort: port, Meta: raw},
		// The mount is ready once the mount table lists it.
		Ready: func(context.Context) (bool, error) {
			ok, err := s.o.mounted(m.MountPoint)
			if err != nil {
				return false, fmt.Errorf("reading the mount table: %w", err)
			}
			return ok, nil
		},
		// i18n: Why a mount failed to start. The value is how long the app waited, as in "30s".
		Late: func(d time.Duration) i18n.Text { return i18n.M("it was not mounted within %s", d) },
	})
	if err != nil {
		if errors.Is(err, children.ErrClosed) { // the app is shutting down, which isn't a mount failure
			return Mount{}, err
		}
		return failed(err)
	}
	c.Log.InfoContext(ctx, "starting a mount", "source", a.Source, "id", c.ID, "config", config)
	return s.view(c), nil
}

// notifiedError is a start failure for which start already sent mount.failed.
type notifiedError struct{ error }

func (e notifiedError) Unwrap() error { return e.error }

func notified(err error) bool { return errors.As(err, new(notifiedError)) }

// env returns what a mount's command line needs, including the name of its cache folder.
func (s *Service) env(nfsPort int) operations.MountEnv {
	return operations.MountEnv{OS: s.o.goos, Exe: s.o.Executable, CacheRoot: s.o.CacheRoot, Config: s.o.Configs.Path(), NFSPort: nfsPort}
}

// reserve adds c to the registry under id, or under a new id when id is "". It refuses a mount
// point that another of the app's mounts already uses. A Windows `*` gets its drive here.
func (s *Service) reserve(c *child, id string) error {
	return s.reg.Reserve(c, id, func(others []*child) error {
		if c.Own.mountPoint == "*" {
			// The cache folder is named after `*`, not the drive, because the drive may change
			// when the mount starts again. So a second `*` mount of the same source would share
			// the first one's cache, and two rclones on one VFS cache corrupt it.
			for _, o := range others {
				if samePath(o.Own.folder, c.Own.folder, s.o.goos) {
					return errs.Errorf("%s is already mounted on a drive Rclone UI picked. Stop that mount first, or choose a drive letter for this one.", c.Source)
				}
			}
			drive, ok := s.freeDrive(others)
			if !ok {
				return errs.New("No drive letter is free for the mount.")
			}
			c.Own.mountPoint = drive
		}
		for _, o := range others {
			switch at, theirs := c.Own.mountPoint, o.Own.mountPoint; {
			case samePath(theirs, at, s.o.goos):
				return errs.Errorf("%s is already a mount of Rclone UI.", at)
			case inside(at, theirs, s.o.goos):
				// The folder would be created through that mount, on its remote.
				return errs.Errorf("%s is inside %s, a mount of Rclone UI. Choose a folder outside it.", at, theirs)
			case inside(theirs, at, s.o.goos):
				// This mount would hide that one.
				return errs.Errorf("%s, a mount of Rclone UI, is inside %s. Stop that mount first, or choose another folder.", theirs, at)
			}
		}
		return nil
	})
}

// freeDrive picks the drive for a Windows `*` mount the way cmount would: the first drive from
// Z: down to D: that isn't in use. The app picks it so that the mount point is known at once,
// instead of being read from cmount's NOTICE line, which a quieter --log-level leaves out. It
// also skips the drives of the app's other mounts that are still starting, because WinFsp only
// creates a drive once it is mounted.
func (s *Service) freeDrive(others []*child) (string, bool) {
	used := s.o.drives()
	ours := map[string]bool{}
	for _, o := range others {
		ours[strings.ToUpper(o.Own.mountPoint)] = true
	}
	for l := 'Z'; l >= 'D'; l-- {
		if drive := string(l) + ":"; used&(1<<(l-'A')) == 0 && !ours[drive] {
			return drive, true
		}
	}
	return "", false
}

// onDrive returns m with its mount point set to mountPoint, which is the drive that reserve
// picked for a Windows `*` (`cmount <fs> <mount point> …`).
func onDrive(m operations.Mount, mountPoint string) operations.Mount {
	if m.MountPoint != "*" || mountPoint == "*" {
		return m
	}
	m.Args = slices.Clone(m.Args)
	if len(m.Args) > 2 && m.Args[2] == "*" {
		m.Args[2] = mountPoint
	}
	m.MountPoint = mountPoint
	return m
}

// up runs when the mount table lists the mount. Any stopped mount of the same source at the
// same place is now sending its uploads through this one, so it is removed from the list.
func (s *Service) up(c *child) {
	c.Own.streak.Up()
	if err := s.deleteStopped(context.Background(), filepath.Base(c.Own.folder)); err != nil {
		c.Log.Warn("could not forget the stopped mount this one resumes", "error", err)
	}
	c.Log.Info("mounted", "source", c.Source, "id", c.ID)
}

// down runs when the child exited, or wasn't ready in time. It clears anything the child left
// mounted. When a first start failed, it settles the cache before the mount point is free for
// another start on the same folder. mount.failed is sent once per streak of failures.
func (s *Service) down(c *child, msg error, again bool) {
	ctx := context.Background()
	s.cleanMountPoint(ctx, c)
	if !again {
		s.settle(ctx, c, -1)
	}
	c.Own.streak.Failed(ctx, notifications.MountFailed{Source: c.Source, Destination: c.Own.mountPoint, Error: i18n.Localize(msg)})
}

// onStop reads a mount's upload queue when a user starts to stop it. Once the child has exited
// (after the grace period, then the kill), the returned function clears anything left mounted.
// It deletes the cache folder when no uploads are waiting there, or keeps it and lists it in
// stopped_mounts when some are.
func (s *Service) onStop(ctx context.Context, c *child) func(context.Context) {
	pending := -1 // unknown
	if u := c.Unit(); u.Process() != nil {
		qctx, cancel := context.WithTimeout(ctx, queueWait)
		queue, err := u.RC().VFSQueue(qctx)
		cancel()
		if err != nil {
			c.Log.WarnContext(ctx, "could not read the mount's upload queue; its cache is looked into after it stops", "error", err)
		} else {
			pending = len(queue)
		}
	}
	return func(ctx context.Context) {
		s.cleanMountPoint(ctx, c)
		s.settle(ctx, c, pending)
	}
}

// cleanMountPoint force-unmounts anything that a dead or killed child left mounted.
func (s *Service) cleanMountPoint(ctx context.Context, c *child) {
	mp := c.Own.mountPoint
	if s.o.goos == "windows" { // WinFsp removes the mount when its process ends
		return
	}
	if ok, err := s.o.mounted(mp); err != nil || !ok {
		return
	}
	if err := s.o.unmount(ctx, mp); err != nil {
		c.Log.ErrorContext(ctx, "could not clear the mount point", "error", err)
		return
	}
	c.Log.InfoContext(ctx, "cleared the mount point")
}

// List returns the registry, oldest first, without the upload queues (ListUploads reads them).
func (s *Service) List() []Mount {
	all := s.reg.All()
	out := make([]Mount, len(all))
	for i, c := range all {
		out[i] = s.view(c)
	}
	return out
}

// view returns c as the pages see it.
func (s *Service) view(c *child) Mount {
	r, own := s.reg.View(c)
	return Mount{
		ID: c.ID, Source: c.Source, MountPoint: own.mountPoint,
		PID: r.PID, State: r.Status, Error: r.Err,
		Automount: own.automount, Restart: r.Restart,
	}
}

// Stop stops a mount. It reads the upload queue and sends the child SIGTERM, so rclone
// unmounts. After 10 s it sends SIGKILL and cleans up. Once the child has exited, its cache
// folder is deleted when no uploads are waiting there, or kept and listed in stopped_mounts when
// some are. The stop keeps going if ctx ends first, or if the child takes longer than stopWait
// to exit. In those cases Stop returns the error, and mounts.changed reports when the mount has
// stopped.
func (s *Service) Stop(ctx context.Context, id string) error { return s.reg.Stop(ctx, id) }

// StopAll stops every mount, as the launcher's "Stop All" does. It returns how many it stopped,
// and joins the errors of the mounts that couldn't be stopped.
func (s *Service) StopAll(ctx context.Context) (int, error) { return s.reg.StopAll(ctx) }

// RemotesChanged flags the mounts that uses picks by their source, because a remote they mount
// has changed. The page shows "Restart to apply" until they start again.
func (s *Service) RemotesChanged(uses func(source string) bool) {
	s.reg.RemotesChanged(func(c *child) bool { return uses(c.Source) })
}

// RC returns a running mount's rc client for the VFS actions, or nil when it isn't running.
func (s *Service) RC(id string) *children.RC { return s.reg.RC(id) }

// publish sends mounts.changed for a mount, with its mount point and its error in the app's
// language. A failed mount also says whether this computer can't mount, so the page can explain
// how to set that up.
func (s *Service) publish(c *child, st children.Status, msg error) {
	if s.o.PointChanged != nil && c.Own.mountPoint != "" && st != children.StatusStarting {
		s.o.PointChanged(c.Own.mountPoint)
	}
	d := bus.MountsChangedData{ID: c.ID, State: string(st), MountPoint: c.Own.mountPoint, Error: i18n.Localize(msg)}
	if st == children.StatusFailed {
		d.CannotMount = !s.o.support().Supported
	}
	s.changed(d)
}

// changed publishes mounts.changed. An event without an ID only means that the stopped mounts
// changed, because one was mounted again or discarded, or that WinFsp was installed.
func (s *Service) changed(d bus.MountsChangedData) {
	if s.o.Bus != nil {
		s.o.Bus.Publish(bus.MountsChanged, d)
	}
}

func samePath(a, b, goos string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if goos == "windows" || goos == "darwin" { // case-insensitive by default
		return strings.EqualFold(a, b)
	}
	return a == b
}

// inside reports whether path a is below folder b, not counting b itself. Paths are compared
// the same way as in samePath, and a drive (`X:`) counts as its root. The prefix is compared
// here rather than with filepath.Rel, which ignores case whenever the app runs on Windows,
// whatever goos is.
func inside(a, b, goos string) bool {
	sep := string(filepath.Separator)
	key := func(p string) string {
		p = filepath.Clean(p)
		if vol := filepath.VolumeName(p); len(vol) == 2 && vol == p {
			p += sep
		}
		if goos == "windows" || goos == "darwin" {
			p = strings.ToLower(p)
		}
		return p
	}
	below, folder := key(a), key(b)
	if !strings.HasSuffix(folder, sep) { // only a root ends with one
		folder += sep
	}
	return len(below) > len(folder) && strings.HasPrefix(below, folder)
}
