package mounts

// This test binary also acts as every mount child that the tests start. An rclone child (marked
// by childenv) runs rclone's command line, as main.go dispatches it. It has one extra rclone
// command, `fakemount`, which runs a real VFS, so the child's rc responds to vfs/queue and
// core/stats, but mounts nothing. Instead it writes a marker file next to the mount point to
// show that it is mounted, and the tests' mount table reads that file.

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/lib/atexit"
	"github.com/rclone/rclone/vfs"
	"github.com/rclone/rclone/vfs/vfscommon"
	"github.com/rclone/rclone/vfs/vfsflags"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(childenv.Env); ok {
		// An rclone child runs rclone's own main, as main.go's runRclone does.
		childenv.Adopt(children.OwnMount)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.AddCommand(fakeMountCommand())
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	slog.SetDefault(slog.New(slog.DiscardHandler))
	// The children, and rclone in this process, use their own home folder.
	testutil.Main(m, func(dir string) error {
		testHome = dir
		return nil
	})
}

// testHome is the tests' home folder (testutil.Main). Anything the tests create outside
// t.TempDir goes in it, so it is removed along with it.
var testHome string

// markerOf returns the path of the fake mount's "mounted" marker for a mount point.
func markerOf(mountPoint string) string { return filepath.Clean(mountPoint) + ".fakemounted" }

// fakeMountCommand is `fakemount <source> <mount point>`. It runs a VFS over the source, and the
// tests' mount table treats it as mounted once its marker is written. SIGTERM, or the parent
// process going away, shuts the VFS down and removes the marker, just as rclone unmounts (unless
// --fake-stay is set). Flags on the mount command line that it doesn't know (--addr,
// --volname…) are ignored.
func fakeMountCommand() *cobra.Command {
	var (
		fail       string
		never      bool
		stay       bool
		write      string
		open       string
		crashAfter time.Duration
	)
	c := &cobra.Command{
		Use:                "fakemount source mountpoint",
		FParseErrWhitelist: cobra.FParseErrWhitelist{UnknownFlags: true},
		Run: func(cmd *cobra.Command, args []string) {
			rclonecmd.CheckArgs(2, 2, cmd, args)
			if fail != "" {
				fs.Fatalf(nil, "fake mount: %s", fail)
			}
			v := vfs.New(context.Background(), rclonecmd.NewFsDir(args), &vfscommon.Opt)
			marker := markerOf(args[1])
			atexit.Register(func() {
				if !stay {
					_ = os.Remove(marker)
				}
				v.Shutdown()
			})
			if write != "" {
				fd, err := v.OpenFile(write, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
				if err == nil {
					_, err = fd.Write([]byte("waiting to upload"))
					_ = fd.Close()
				}
				if err != nil {
					fs.Fatalf(nil, "fake mount: write: %v", err)
				}
			}
			if open != "" { // written and left open: dirty, but not in the upload queue
				fd, err := v.OpenFile(open, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
				if err == nil {
					_, err = fd.Write([]byte("still being written"))
				}
				if err != nil {
					fs.Fatalf(nil, "fake mount: open: %v", err)
				}
			}
			if !never {
				if err := os.WriteFile(marker, nil, 0o600); err != nil {
					fs.Fatalf(nil, "fake mount: %v", err)
				}
			}
			if crashAfter > 0 {
				time.Sleep(crashAfter)
				fs.Errorf(nil, "fake mount: crashed")
				os.Exit(1) // no unmount, so the marker stays, as a dead mount does
			}
			select {}
		},
	}
	c.Flags().StringVar(&fail, "fake-fail", "", "fail at once with this error")
	c.Flags().BoolVar(&never, "fake-never", false, "never mount")
	c.Flags().BoolVar(&stay, "fake-stay", false, "stay mounted after a stop, as an unmount the OS refused leaves it")
	c.Flags().StringVar(&write, "fake-write", "", "write this file through the VFS")
	c.Flags().StringVar(&open, "fake-open", "", "write this file through the VFS and keep it open")
	c.Flags().DurationVar(&crashAfter, "fake-crash-after", 0, "crash this long after mounting")
	vfsflags.AddFlags(c.Flags())
	return c
}

// configs is the config service as the mounts see it: one plain file.
type configs struct {
	mu   sync.Mutex
	path string
	err  error // returned by ChildPassword when set
}

func (c *configs) Path() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.path
}

func (c *configs) ChildPassword(context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return "", c.err
}

// fixture is a Service with a fresh app.db and a real supervisor whose mount children run
// fakemount.
type fixture struct {
	t       *testing.T
	s       *Service
	sup     *children.Supervisor
	db      *db.DB
	bus     *bus.Bus
	configs *configs
	notes   *notes
	ev      *events
	lines   *lines
	ctx     context.Context

	base   string // sources and mount points
	data   string // the data dir: rclone.conf, cache
	run    string
	cache  string
	config string

	mu        sync.Mutex
	fakeArgs  []string
	unmounted atomic.Int32
}

type fixtureOpts struct {
	logLevel string // the children's log level; INFO when ""
	pending  []children.Record
	run      string // an earlier fixture's run dir, to simulate a restart
	data     string
	db       *db.DB
	tweak    func(*Options)
}

func newFixture(t *testing.T, fo ...fixtureOpts) *fixture {
	t.Helper()
	var o fixtureOpts
	if len(fo) > 0 {
		o = fo[0]
	}
	f := &fixture{t: t, notes: &notes{}, lines: &lines{}, base: t.TempDir(), data: o.data, run: o.run, db: o.db}
	if f.data == "" {
		f.data = t.TempDir()
	}
	if f.run == "" {
		dir, err := os.MkdirTemp("", "rcui-") // kept short because socket paths have a length limit
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		f.run = dir
	}
	f.cache = filepath.Join(f.data, "cache")
	f.config = filepath.Join(f.data, "rclone.conf")
	if _, err := os.Stat(f.config); err != nil {
		if err := os.WriteFile(f.config, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f.configs = &configs{path: f.config}
	if f.db == nil {
		d, err := db.Open(context.Background(), filepath.Join(f.data, "app.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Close() })
		f.db = d
	}
	f.bus = bus.New()
	f.notes.bus = f.bus
	f.ev = collect(t, f.bus)
	sup, err := children.New(children.Options{
		RunDir:   f.run,
		Exe:      os.Args[0],
		CacheDir: f.cache,
		Emit:     f.lines.emit,
		Limits:   func() children.Limits { return children.Limits{LogLevel: cmp.Or(o.logLevel, "INFO")} },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sup.Begin(o.pending); err != nil {
		t.Fatal(err)
	}
	f.sup = sup
	opts := Options{
		DB: f.db, Bus: f.bus, Notifier: f.notes, Children: sup, Configs: f.configs,
		CacheRoot: f.cache, Executable: os.Args[0],
		mounted: func(mp string) (bool, error) {
			_, err := os.Stat(markerOf(mp))
			return err == nil, nil
		},
		unmount: func(_ context.Context, mp string) error {
			f.unmounted.Add(1)
			return os.Remove(markerOf(mp))
		},
		command: func(a operations.MountArgs, env operations.MountEnv) (operations.Mount, error) {
			m, err := operations.MountCommand(a, env)
			if err != nil {
				return m, err
			}
			f.mu.Lock()
			m.Args = append(append([]string{"fakemount"}, m.Args[1:]...), f.fakeArgs...)
			f.mu.Unlock()
			return m, nil
		},
		support: func() Support { return Support{Supported: true} },
		backoff: children.Backoff{Min: 50 * time.Millisecond, Max: 200 * time.Millisecond, Reset: time.Hour},
	}
	if o.tweak != nil {
		o.tweak(&opts)
	}
	f.s = New(opts)
	f.ctx = context.Background()
	t.Cleanup(func() {
		sctx, scancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer scancel()
		if err := sup.StopAll(sctx, nil); err != nil {
			t.Errorf("stop every child: %v", err)
		}
	})
	return f
}

// fake sets the fake mount's own flags for the next starts.
func (f *fixture) fake(args ...string) {
	f.mu.Lock()
	f.fakeArgs = args
	f.mu.Unlock()
}

// place returns a source folder with a file in it, and a mount point under base written the
// way the mount command writes it (with forward slashes on Windows).
func (f *fixture) place(name string) (src, mp string) {
	f.t.Helper()
	src = filepath.Join(f.base, name+"-src")
	if err := os.MkdirAll(src, 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("a"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	return src, filepath.ToSlash(filepath.Join(f.base, name+"-mnt"))
}

// start starts a mount and waits for the state it reaches first after starting.
func (f *fixture) start(a operations.MountArgs) (Mount, bus.MountsChangedData) {
	f.t.Helper()
	m, err := f.s.Start(f.ctx, a)
	if err != nil {
		f.t.Fatalf("start: %v", err)
	}
	return m, f.ev.wait(f.t, m.ID, children.StatusRunning, children.StatusFailed)
}

func (f *fixture) stoppedRows() []StoppedMount {
	f.t.Helper()
	list, err := f.s.Stopped(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	return list
}

func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if err := f.db.Write(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(q, args...)
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
}

// notes records the notifications that were sent.
type notes struct {
	bus  *bus.Bus
	mu   sync.Mutex
	list []note
}

type note struct {
	event   notifications.NotificationEvent
	payload notifications.Payload
}

func (n *notes) Notify(_ context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	n.mu.Lock()
	n.list = append(n.list, note{event, p})
	n.mu.Unlock()
}

// Desktop shows a desktop notification as the notification service does once the UI has
// subscribed: on the bus.
func (n *notes) Desktop(_ context.Context, e notifications.NotificationEvent, p notifications.Payload, d notifications.Desktop) {
	n.bus.Publish(bus.NotifyOS, d.NotifyOS(e, p))
}

func (n *notes) get() []note {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.list)
}

// events collects mounts.changed events and the OS notifications that were requested.
type events struct {
	mu     sync.Mutex
	list   []bus.MountsChangedData
	toasts []bus.NotifyOSData
	ch     chan struct{}
}

func collect(t *testing.T, b *bus.Bus) *events {
	e := &events{ch: make(chan struct{}, 1)}
	sub := b.Subscribe()
	t.Cleanup(sub.Close)
	go func() {
		for ev := range sub.C {
			if n, ok := ev.Data.(bus.NotifyOSData); ok && ev.Name == bus.NotifyOS {
				e.mu.Lock()
				e.toasts = append(e.toasts, n)
				e.mu.Unlock()
				continue
			}
			if c, ok := ev.Data.(bus.MountsChangedData); ok && ev.Name == bus.MountsChanged {
				e.mu.Lock()
				e.list = append(e.list, c)
				e.mu.Unlock()
				select {
				case e.ch <- struct{}{}:
				default:
				}
			}
		}
	}()
	return e
}

func (e *events) toastTitles() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, n := range e.toasts {
		out = append(out, n.Title)
	}
	return out
}

func (e *events) of(id string) []bus.MountsChangedData {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []bus.MountsChangedData
	for _, c := range e.list {
		if c.ID == id {
			out = append(out, c)
		}
	}
	return out
}

// wait returns the first event for id in one of states, and fails after a minute.
func (e *events) wait(t *testing.T, id string, states ...children.Status) bus.MountsChangedData {
	t.Helper()
	return e.waitN(t, id, 1, states...)
}

// waitN returns the nth event for id in one of states.
func (e *events) waitN(t *testing.T, id string, n int, states ...children.Status) bus.MountsChangedData {
	t.Helper()
	deadline := time.After(time.Minute)
	for {
		seen := 0
		for _, c := range e.of(id) {
			if slices.Contains(states, children.Status(c.State)) {
				if seen++; seen == n {
					return c
				}
			}
		}
		select {
		case <-e.ch:
		case <-deadline:
			t.Fatalf("no event %d of %s in %v; got %+v", n, id, states, e.of(id))
		}
	}
}

// lines collects the children's log lines.
type lines struct {
	mu   sync.Mutex
	list []logs.Record
}

func (l *lines) emit(e logs.Record) {
	l.mu.Lock()
	l.list = append(l.list, e)
	l.mu.Unlock()
}

// cacheRefused returns a child's line saying that its VFS cache couldn't be created, or "".
func (l *lines) cacheRefused() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.list {
		if strings.Contains(e.Message, "Failed to create vfs cache") {
			return e.Message
		}
	}
	return ""
}

func (l *lines) dump() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, e := range l.list {
		fmt.Fprintf(&b, "%s/%s %v: %s\n", e.Component, e.Subcomponent, e.Level, e.Message)
	}
	return b.String()
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// groupsOf returns option groups as a page sends them, from pairs of name and JSON.
func groupsOf(kv ...string) operations.Groups {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%q:%s", kv[i], kv[i+1])
	}
	b.WriteByte('}')
	var g operations.Groups
	if err := json.Unmarshal([]byte(b.String()), &g); err != nil {
		panic(fmt.Sprintf("groups %s: %v", b.String(), err))
	}
	return g
}
