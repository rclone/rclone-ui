package serves

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/serve/http"
	_ "github.com/rclone/rclone/cmd/serve/webdav"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
)

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(childenv.Env); ok {
		if hold := os.Getenv(holdEnv); hold != "" {
			for {
				if _, err := os.Stat(hold); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		childenv.Adopt(nil)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	slog.SetDefault(slog.New(slog.DiscardHandler))
	testutil.Main(m, nil)
}

const holdEnv = "SERVES_TEST_HOLD"

type configs struct {
	mu   sync.Mutex
	path string
	err  error
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

type secrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (k *secrets) Get(account string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.m[account]
	if !ok {
		return "", errors.New("no such secret")
	}
	return v, nil
}

func (k *secrets) Set(account, secret string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.m == nil {
		k.m = map[string]string{}
	}
	k.m[account] = secret
	return nil
}

func (k *secrets) Delete(account string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.m, account)
	return nil
}

func (k *secrets) all() map[string]string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return maps.Clone(k.m)
}

type fixture struct {
	t       *testing.T
	s       *Service
	sup     *children.Supervisor
	db      *db.DB
	configs *configs
	secrets *secrets
	notes   *notes
	ev      *events
	lines   *lines
	ctx     context.Context
	data    string
	run     string
	config  string
}

type fixtureOpts struct {
	pending []children.Record
	run     string
	data    string
	db      *db.DB
	secrets *secrets
	tweak   func(*Options)
}

func newFixture(t *testing.T, fo ...fixtureOpts) *fixture {
	t.Helper()
	var o fixtureOpts
	if len(fo) > 0 {
		o = fo[0]
	}
	f := &fixture{t: t, notes: &notes{}, lines: &lines{}, data: o.data, run: o.run, db: o.db, secrets: o.secrets}
	if f.secrets == nil {
		f.secrets = &secrets{}
	}
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
	if f.db == nil {
		d, err := db.Open(context.Background(), filepath.Join(f.data, "app.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Close() })
		f.db = d
	}
	f.config = filepath.Join(f.data, "rclone.conf")
	if _, err := os.Stat(f.config); err != nil {
		if err := os.WriteFile(f.config, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f.configs = &configs{path: f.config}
	b := bus.New()
	f.ev = collect(t, b)
	sup, err := children.New(children.Options{
		RunDir:   f.run,
		Exe:      os.Args[0],
		CacheDir: filepath.Join(f.data, "cache"),
		Emit:     f.lines.emit,
		Limits:   func() children.Limits { return children.Limits{LogLevel: "INFO"} },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sup.Begin(o.pending); err != nil {
		t.Fatal(err)
	}
	f.sup = sup
	opts := Options{
		Bus: b, Notifier: f.notes, Children: sup, Configs: f.configs, Executable: os.Args[0], Secrets: f.secrets,
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

func (f *fixture) folder() string {
	f.t.Helper()
	dir := f.t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	return dir
}

type notes struct {
	mu   sync.Mutex
	list []notifications.Payload
	next func()
}

func (n *notes) Notify(_ context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	if event != notifications.NotificationEventServeFailed {
		panic("notified " + string(event))
	}
	n.mu.Lock()
	n.list = append(n.list, p)
	next := n.next
	n.next = nil
	n.mu.Unlock()
	if next != nil {
		next()
	}
}

func (n *notes) onNext(fn func()) {
	n.mu.Lock()
	n.next = fn
	n.mu.Unlock()
}

func (n *notes) Desktop(_ context.Context, e notifications.NotificationEvent, _ notifications.Payload, _ notifications.Desktop) {
	panic("desktop notification " + string(e))
}

func (n *notes) get() []notifications.Payload {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.list)
}

type events struct {
	mu   sync.Mutex
	list []bus.ServesChangedData
	ch   chan struct{}
}

func collect(t *testing.T, b *bus.Bus) *events {
	e := &events{ch: make(chan struct{}, 1)}
	sub := b.Subscribe()
	t.Cleanup(sub.Close)
	go func() {
		for ev := range sub.C {
			if c, ok := ev.Data.(bus.ServesChangedData); ok && ev.Name == bus.ServesChanged {
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

func (e *events) count(id string, state children.Status) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, c := range e.list {
		if c.ID == id && c.State == string(state) {
			n++
		}
	}
	return n
}

func (e *events) waitN(t *testing.T, id string, n int, states ...children.Status) bus.ServesChangedData {
	t.Helper()
	deadline := time.After(time.Minute)
	for {
		seen := 0
		e.mu.Lock()
		list := slices.Clone(e.list)
		e.mu.Unlock()
		for _, c := range list {
			if c.ID == id && slices.Contains(states, children.Status(c.State)) {
				if seen++; seen == n {
					return c
				}
			}
		}
		select {
		case <-e.ch:
		case <-deadline:
			t.Fatalf("no event %d of %s in %v; got %+v", n, id, states, list)
		}
	}
}

type lines struct {
	mu   sync.Mutex
	list []logs.Record
}

func (l *lines) emit(e logs.Record) {
	l.mu.Lock()
	l.list = append(l.list, e)
	l.mu.Unlock()
}

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
