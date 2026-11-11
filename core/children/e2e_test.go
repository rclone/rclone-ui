package children

// End-to-end tests with real rclone children. Each child is this test binary running rclone's
// command line, as main.go dispatches it. The tests check that the children read their config
// file (an encrypted one through a one-time key file), start with the core's limits, and end
// when the core's end of their stdin closes (the watchdog).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// app holds what a test's core needs: a supervisor, and a config file with a remote `photos`.
type app struct {
	s      *Supervisor
	got    *entries
	run    string
	data   string
	config string
	photos string // the folder that the photos: alias points to
}

func newApp(t *testing.T, limits Limits) *app {
	t.Helper()
	a := &app{got: newEntries(), run: runDir(t), data: t.TempDir(), photos: t.TempDir()}
	a.config = filepath.Join(a.data, "rclone.conf")
	writeFile(t, a.config, "[photos]\ntype = alias\nremote = "+filepath.ToSlash(a.photos)+"\n")
	a.s = newSupervisor(t, Options{
		RunDir:   a.run,
		Exe:      os.Args[0],
		CacheDir: filepath.Join(a.data, "cache"),
		Emit:     a.got.emit,
		Limits:   func() Limits { return limits },
	})
	return a
}

// once runs a rclone child until it ends and returns its plain output lines. The rclone child
// parser turns a line that is not JSON into an error record.
func (a *app) once(t *testing.T, name, password string, args ...string) (Down, []string) {
	t.Helper()
	d := newDowns(1)
	u, err := a.s.Start(Spec{
		Name: name, Kind: "test", Rclone: args, ConfigPath: a.config, ConfigPassword: password,
		Component: logs.CompChildren, Subcomponent: name,
		OnDown: d.onDown,
	})
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 60*time.Second, name+" to end")
	var lines []string
	for _, e := range a.got.snapshot() {
		if e.Subcomponent == name && !strings.HasPrefix(e.Message, "{") && e.Source == "" {
			lines = append(lines, e.Message)
		}
	}
	return d.get()[0], lines
}

// serve starts `serve http <dir>` on a free port. The serve is ready once its address answers.
func (a *app) serve(t *testing.T, name, dir string, onDown func(*Unit, Down) bool) (*Unit, string) {
	t.Helper()
	addr := freeAddr(t)
	up := make(chan struct{}, 1)
	u, err := a.s.Start(Spec{
		Name: name, Kind: KindServe, Addr: addr, ConfigPath: a.config,
		Rclone:    []string{"serve", "http", dir, "--addr=" + addr},
		Component: logs.CompServes, Subcomponent: "http:" + addr,
		Ready:  func(ctx context.Context, _ *Process) error { return tcpReady(ctx, addr) },
		OnUp:   func(*Unit) { up <- struct{}{} },
		OnDown: onDown,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-up:
	case <-u.Done():
		t.Fatalf("%s ended before it was up", name)
	case <-time.After(60 * time.Second):
		t.Fatalf("%s was not up in time", name)
	}
	return u, addr
}

// ended reports whether a child ran to its end on its own, with status 0.
func ended(d Down) bool { return d.Err != nil && d.Err.Error() == "exited with status 0" }

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().String()
}

// tcpReady waits until a serve's address accepts a connection.
func tcpReady(ctx context.Context, addr string) error {
	for {
		var d net.Dialer
		if c, err := d.DialContext(ctx, "tcp", addr); err == nil {
			_ = c.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func rcCall(t *testing.T, r *RC, path string, in rc.Params) rc.Params {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := r.Call(ctx, path, in)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func get(t *testing.T, url string) (string, int) {
	t.Helper()
	resp, err := http.Get(url) //nolint:noctx // a test's local server
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return string(b), resp.StatusCode
}

func TestChildrenReadTheirConfig(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO"})
	writeFile(t, filepath.Join(a.photos, "a.txt"), "a")
	d, lines := a.once(t, "lsf", "", "lsf", "photos:")
	if !ended(d) || len(lines) != 1 || lines[0] != "a.txt" {
		t.Fatalf("lsf photos: %v %q", d.Err, lines)
	}
	_, addr := a.serve(t, "serve", "photos:", nil)
	if body, status := get(t, "http://"+addr+"/a.txt"); status != http.StatusOK || body != "a" {
		t.Fatalf("GET a.txt: %d %q", status, body)
	}
}

// TestEncryptedConfigThroughTheKeyFile checks that a child opens an encrypted config with the
// key that the core wrote for it, and that the key file is gone afterwards. A wrong password
// makes the child fail.
func TestEncryptedConfigThroughTheKeyFile(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO"})
	writeFile(t, filepath.Join(a.photos, "b.txt"), "b")
	plain, err := os.ReadFile(a.config)
	if err != nil {
		t.Fatal(err)
	}
	enc, err := rclone.EncryptConfig(plain, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, a.config, string(enc))
	d, lines := a.once(t, "lsf", "s3cret", "lsf", "photos:")
	if !ended(d) || len(lines) != 1 || lines[0] != "b.txt" {
		t.Fatalf("lsf photos: with the key: %v %q", d.Err, lines)
	}
	if keys, _ := filepath.Glob(filepath.Join(a.run, "key-*")); len(keys) != 0 {
		t.Fatalf("key files left: %v", keys)
	}
	if d, _ := a.once(t, "wrong", "nope", "lsf", "photos:"); ended(d) {
		t.Fatal("a wrong password listed the remote")
	}
}

func TestLimitsReachChildren(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO", BwLimit: "1Mi", TPSLimit: 5, TPSLimitBurst: 2, UserAgent: "rcui-test/1"})
	u, _ := a.serve(t, "serve", t.TempDir(), nil)
	main := func() map[string]any {
		m, _ := rcCall(t, u.RC(), "options/get", nil)["main"].(map[string]any)
		return m
	}
	m := main()
	for k, want := range map[string]any{"BwLimit": "1Mi", "TPSLimit": 5.0, "TPSLimitBurst": 2.0, "UserAgent": "rcui-test/1", "LogLevel": "INFO"} {
		if got := m[k]; fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("the child's %s = %v, want %v", k, got, want)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// The child's vfs/queue works over the same socket, but only with the child's credentials.
	if q, err := u.RC().VFSQueue(ctx); err != nil || len(q) != 0 {
		t.Fatalf("vfs/queue = %v, %v", q, err)
	}
	bad := &RC{sock: u.RC().sock, user: "someone", pass: "else", hc: u.RC().hc}
	var rcErr *RCError
	if _, err := bad.VFSQueue(ctx); !errors.As(err, &rcErr) || rcErr.Status != http.StatusUnauthorized {
		t.Fatalf("vfs/queue with the wrong credentials: %v", err)
	}
}

// TestWatchdog checks that a child exits when its stdin closes, as it does when the app dies.
func TestWatchdog(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO"})
	d := newDowns(1)
	u, _ := a.serve(t, "serve", t.TempDir(), d.onDown)
	p := u.Process()
	if err := p.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, p.exited, 15*time.Second, "the child to exit after its stdin closed")
	waitClosed(t, u.Done(), 15*time.Second, "the down")
	if got := d.get(); len(got) != 1 || got[0].Err == nil || !got[0].WasUp {
		t.Fatalf("downs %+v", got)
	}
}

// TestChildSecretsStayOutOfTheLogs checks that secrets are masked in a child's logs. At DEBUG
// level, before its logging is set up, rclone prints the flags it read from the environment with
// their values quoted. These include its rc password and a serve's password (SecretEnv).
func TestChildSecretsStayOutOfTheLogs(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "DEBUG"})
	const servePass = `pa"ss\word` // %q escapes both
	u, err := a.s.Start(Spec{Name: "lsf", Kind: "test", Rclone: []string{"lsf", "photos:"}, ConfigPath: a.config,
		SecretEnv: []string{"RCLONE_PASS=" + servePass},
		OnDown:    func(*Unit, Down) bool { return false }})
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 60*time.Second, "lsf to end")
	for _, v := range []string{"RCLONE_RC_PASS", "RCLONE_PASS"} {
		a.got.wait(t, 5*time.Second, "about "+v+", redacted", func(e logs.Record) bool {
			return strings.Contains(e.Message, v+`="***"`)
		})
	}
	quoted := strconv.Quote(servePass)
	for _, e := range a.got.snapshot() {
		for _, secret := range []string{u.rc.pass, servePass, quoted[1 : len(quoted)-1]} {
			if strings.Contains(e.Message, secret) {
				t.Fatalf("a child's secret in its logs: %q", e.Message)
			}
		}
	}
}

// TestSocketGoesWithTheChild checks that a killed rclone child's rc socket is removed once its
// unit has ended. rclone never removes its rc socket itself.
func TestSocketGoesWithTheChild(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO"})
	u, _ := a.serve(t, "killed", t.TempDir(), func(*Unit, Down) bool { return false })
	sock := rcSock(a.run, u.ID())
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("while it runs: %v", err)
	}
	if err := u.Process().cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 15*time.Second, "the unit to end")
	if _, err := os.Stat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the rc socket after the child was killed: %v", err)
	}
}
