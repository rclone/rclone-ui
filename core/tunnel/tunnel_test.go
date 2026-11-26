package tunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/cat"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/tunnel/cloudflared"
	"github.com/rclone/rclone-ui/core/tunnel/tunnelcmd"
)

const originFileEnv = "TUNNEL_TEST_ORIGIN_FILE"

const slowEnv = "TUNNEL_TEST_SLOW"

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(childenv.Env); ok {
		childenv.Adopt(nil)
		tunnelcmd.Install(rclonecmd.Root, fakeEdge)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == "cat" {
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	slog.SetDefault(slog.New(slog.DiscardHandler))
	testutil.Main(m, nil)
}

func fakeEdge(_ context.Context, origin string, _ cloudflared.Options) (*cloudflared.Tunnel, error) {
	if d, err := time.ParseDuration(os.Getenv(slowEnv)); err == nil {
		time.Sleep(d)
	}
	if f := os.Getenv(originFileEnv); f != "" {
		if err := os.WriteFile(f, []byte(origin), 0o600); err != nil {
			return nil, err
		}
	}
	return &cloudflared.Tunnel{URL: fmt.Sprintf("https://fake-%d.trycloudflare.com", os.Getpid()), Done: make(chan error)}, nil
}

type configs struct {
	mu       sync.Mutex
	path     string
	password string
	block    chan struct{}
}

func (c *configs) Path() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.path
}

func (c *configs) ChildPassword(ctx context.Context) (string, error) {
	c.mu.Lock()
	block := c.block
	c.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.password, nil
}

type fixture struct {
	s       *Service
	sup     *children.Supervisor
	configs *configs
	run     string
	data    string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	run, err := os.MkdirTemp("", "rcui-") // kept short because socket paths have a length limit
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	data := t.TempDir()
	conf := filepath.Join(data, "rclone.conf")
	if err := os.WriteFile(conf, []byte("[disk]\ntype = local\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sup, err := children.New(children.Options{
		RunDir: run, Exe: os.Args[0], CacheDir: filepath.Join(data, "cache"),
		Emit:   func(logs.Record) {},
		Limits: func() children.Limits { return children.Limits{LogLevel: "INFO"} },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sup.Begin(nil); err != nil {
		t.Fatal(err)
	}
	f := &fixture{sup: sup, configs: &configs{path: conf}, run: run, data: data}
	f.s = New(Options{DB: testdb.Open(t), Bus: bus.New(), Children: sup, Configs: f.configs})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = sup.StopAll(ctx, nil)
	})
	return f
}

func TestTunnel(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	st, err := f.s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != StateOn || !strings.HasSuffix(st.URL, ".trycloudflare.com") || len(st.User) < 8 || len(st.Pass) < 16 {
		t.Fatalf("status %+v", st)
	}
	again, err := f.s.Start(ctx)
	if err != nil || again != st {
		t.Fatalf("a second start: %+v %v", again, err)
	}

	f.s.Shutdown(ctx, true)
	if s := f.s.Status(); s.State != StateOff {
		t.Fatalf("after the shutdown: %+v", s)
	}
	next := New(Options{DB: f.s.o.DB, Bus: bus.New(), Children: f.sup, Configs: f.configs})
	next.Boot(ctx)
	if s := next.Status(); s.State != StateOn {
		t.Fatalf("after the boot: %+v", s)
	}
	if err := next.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	third := New(Options{DB: f.s.o.DB, Bus: bus.New(), Children: f.sup, Configs: f.configs})
	third.Boot(ctx)
	if s := third.Status(); s.State != StateOff {
		t.Fatalf("a boot after a plain stop: %+v", s)
	}
}

func TestShutdownEndsAStart(t *testing.T) {
	f := newFixture(t)
	t.Setenv(slowEnv, "1m")
	started := make(chan error, 1)
	go func() {
		_, err := f.s.Start(context.Background())
		started <- err
	}()
	testutil.Eventually(t, 10*time.Second, "the tunnel starting", func() bool {
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		return f.s.unit != nil && f.s.status.State == StateStarting
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	began := time.Now()
	f.s.Shutdown(ctx, false)
	if d := time.Since(began); d > 15*time.Second {
		t.Fatalf("the shutdown took %v", d)
	}
	if st := f.s.Status(); st.State != StateOff {
		t.Fatalf("after the shutdown: %+v", st)
	}
	select {
	case err := <-started:
		if !errors.Is(err, errStopping) {
			t.Fatalf("the start: %v, want errStopping", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the start still waits")
	}
	f.s.o.spawned = func(*children.Unit) { t.Error("a start after the shutdown started a child") }
	if _, err := f.s.Start(context.Background()); !errors.Is(err, errStopping) {
		t.Fatalf("a start after the shutdown: %v", err)
	}
}

func TestShutdownRecordsAStart(t *testing.T) {
	for _, c := range []struct {
		name  string
		block bool
		slow  string
	}{
		{"before its child", true, ""},
		{"waiting for its address", false, "20s"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv(slowEnv, c.slow)
			release := make(chan struct{})
			if c.block {
				f.configs.block = release
			}
			ctx := context.Background()
			started := make(chan error, 1)
			go func() {
				_, err := f.s.Start(ctx)
				started <- err
			}()
			testutil.Eventually(t, 10*time.Second, "the tunnel starting", func() bool {
				f.s.mu.Lock()
				defer f.s.mu.Unlock()
				return f.s.status.State == StateStarting && (c.block || f.s.unit != nil)
			})
			shut := make(chan struct{})
			go func() {
				f.s.Shutdown(ctx, true)
				close(shut)
			}()
			<-f.s.closing.Done()
			close(release)
			waitFor(t, shut, 10*time.Second, "the shutdown")
			select {
			case err := <-started:
				if !errors.Is(err, errStopping) {
					t.Fatalf("the start: %v, want errStopping", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("the start still waits")
			}

			t.Setenv(slowEnv, "")
			f.configs.block = nil
			next := New(Options{DB: f.s.o.DB, Bus: bus.New(), Children: f.sup, Configs: f.configs})
			next.Boot(ctx)
			if s := next.Status(); s.State != StateOn {
				t.Fatalf("after the boot: %+v", s)
			}
			if err := next.Stop(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func waitFor(t *testing.T, ch <-chan struct{}, d time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(d):
		t.Fatalf("%s did not end in %v", what, d)
	}
}

func TestTunnelAnswers(t *testing.T) {
	f := newFixture(t)
	photos := t.TempDir()
	if err := os.WriteFile(filepath.Join(photos, "a.txt"), []byte("the photo"), 0o600); err != nil {
		t.Fatal(err)
	}
	enc, err := rclone.EncryptConfig([]byte("[photos]\ntype = alias\nremote = "+photos+"\n"), "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.configs.path, enc, 0o600); err != nil {
		t.Fatal(err)
	}
	f.configs.password = "s3cret"
	originFile := filepath.Join(t.TempDir(), "origin")
	t.Setenv(originFileEnv, originFile)

	st, err := f.s.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.s.Stop(context.Background()) }()
	origin, err := os.ReadFile(originFile)
	if err != nil {
		t.Fatal(err)
	}
	post := func(path, body string, auth bool) (int, string) {
		req, _ := http.NewRequest(http.MethodPost, string(origin)+"/"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if auth {
			req.SetBasicAuth(st.User, st.Pass)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, _ := post("rc/noop", "{}", false); code != http.StatusUnauthorized {
		t.Fatalf("without the credentials: %d", code)
	}
	if code, body := post("rc/noop", `{"a":1}`, true); code != http.StatusOK || !strings.Contains(body, `"a"`) {
		t.Fatalf("rc/noop: %d %s", code, body)
	}
	code, body := post("core/command", `{"command":"cat","arg":["photos:a.txt"]}`, true)
	if code != http.StatusOK || !strings.Contains(body, `"result": "the photo"`) || strings.Contains(body, `"error": true`) {
		t.Fatalf("core/command cat: %d %s", code, body)
	}
	if keys, _ := filepath.Glob(filepath.Join(f.run, "key-*")); len(keys) != 0 {
		t.Fatalf("key files left: %v", keys)
	}
}

func TestLines(t *testing.T) {
	s := New(Options{})
	s.url = make(chan string, 1)
	parse := s.lines()
	now := time.Now()
	rec, _ := parse(`{"time":"2026-09-30T12:00:00Z","level":"warn","message":"Cannot determine default origin"}`, logs.Stderr, now)
	if rec.Subcomponent != "cloudflared" || rec.Level != slog.LevelWarn || rec.Message != "Cannot determine default origin" {
		t.Errorf("cloudflared's line: %+v", rec)
	}
	rec, _ = parse(`{"time":"2026-09-30T12:00:01Z","level":"notice","msg":"The tunnel is on at https://abc.trycloudflare.com","source":"x.go:1"}`, logs.Stderr, now)
	if rec.Subcomponent != "rclone" || rec.Message != "The tunnel is on at https://abc.trycloudflare.com" {
		t.Errorf("rclone's line: %+v", rec)
	}
	select {
	case url := <-s.url:
		if url != "https://abc.trycloudflare.com" {
			t.Errorf("url %q", url)
		}
	default:
		t.Error("no address handed on")
	}
}

func TestStopEndsAStart(t *testing.T) {
	for _, c := range []struct {
		name  string
		block bool
		slow  string
	}{
		{"before its child", true, ""},
		{"waiting for its address", false, "1m"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv(slowEnv, c.slow)
			if c.block {
				f.configs.block = make(chan struct{})
			}
			type answer struct {
				st  Status
				err error
			}
			started := make(chan answer, 1)
			go func() {
				st, err := f.s.Start(context.Background())
				started <- answer{st, err}
			}()
			testutil.Eventually(t, 10*time.Second, "the tunnel starting", func() bool {
				f.s.mu.Lock()
				defer f.s.mu.Unlock()
				return f.s.status.State == StateStarting && (c.block || f.s.unit != nil)
			})
			began := time.Now()
			if err := f.s.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
			if d := time.Since(began); d > 15*time.Second {
				t.Fatalf("the stop took %v", d)
			}
			select {
			case a := <-started:
				if a.err != nil || a.st.State != StateOff {
					t.Fatalf("the start answered %+v %v", a.st, a.err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the start still waits")
			}
			if st := f.s.Status(); st.State != StateOff || st.Err != nil {
				t.Fatalf("after the stop: %+v", st)
			}

			t.Setenv(slowEnv, "")
			f.configs.mu.Lock()
			f.configs.block = nil
			f.configs.mu.Unlock()
			if st, err := f.s.Start(context.Background()); err != nil || st.State != StateOn {
				t.Fatalf("a start after the stop: %+v %v", st, err)
			}
			if err := f.s.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStartOutlivesItsRequest(t *testing.T) {
	f := newFixture(t)
	t.Setenv(slowEnv, "1s")
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan error, 1)
	go func() {
		_, err := f.s.Start(ctx)
		started <- err
	}()
	testutil.Eventually(t, 10*time.Second, "the tunnel starting", func() bool {
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		return f.s.unit != nil
	})
	cancel()
	select {
	case err := <-started:
		if err != nil {
			t.Fatalf("the start: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the start still waits")
	}
	if st := f.s.Status(); st.State != StateOn {
		t.Fatalf("status %+v", st)
	}
	if err := f.s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFirstStartFailsAtOnce(t *testing.T) {
	run, err := os.MkdirTemp("", "rcui-") // kept short because socket paths have a length limit
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	data := t.TempDir()
	sup, err := children.New(children.Options{
		RunDir: run, Exe: filepath.Join(data, "moved-away"), CacheDir: filepath.Join(data, "cache"),
		Emit: func(logs.Record) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sup.Begin(nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sup.StopAll(context.Background(), nil) })
	conf := filepath.Join(data, "rclone.conf")
	if err := os.WriteFile(conf, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(Options{DB: testdb.Open(t), Bus: bus.New(), Children: sup, Configs: &configs{path: conf},
		spawned: func(u *children.Unit) { <-u.Done() }})
	for i := range 2 {
		st, err := s.Start(context.Background())
		if err == nil || st.State != StateOff || st.Err == nil {
			t.Fatalf("start %d: %+v %v", i+1, st, err)
		}
		s.mu.Lock()
		kept := s.unit
		s.mu.Unlock()
		if kept != nil {
			t.Fatalf("start %d kept its dead unit", i+1)
		}
	}
}
