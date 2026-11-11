package serves

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

func TestResolvePort(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:0", "localhost:0", ":0"} {
		got, err := resolvePort(addr)
		if err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
		host, port, _ := net.SplitHostPort(got)
		wantHost, _, _ := net.SplitHostPort(addr)
		if host != wantHost || port == "0" || port == "" {
			t.Fatalf("%s resolved to %s", addr, got)
		}
	}
	for _, addr := range []string{"127.0.0.1:8080", "unix:///tmp/x.sock", ""} {
		if got, _ := resolvePort(addr); got != addr {
			t.Fatalf("%s changed to %s", addr, got)
		}
	}
	for addr, want := range map[string]string{
		":8080": "127.0.0.1:8080", "0.0.0.0:21": "127.0.0.1:21", "[::]:22": "[::1]:22", "localhost:2121": "localhost:2121",
	} {
		if _, got := dialTarget(addr); got != want {
			t.Fatalf("dial %s at %s, want %s", addr, got, want)
		}
	}
	if network, path := dialTarget("unix:///run/x.sock"); network != "unix" || path != "/run/x.sock" {
		t.Fatalf("unix socket %s %s", network, path)
	}
}

// TestSameListener checks that two serves on the same port clash whatever their hosts, and that
// a unix socket is compared by its path. A different port doesn't clash.
func TestSameListener(t *testing.T) {
	for _, pair := range [][2]string{
		{":8080", "0.0.0.0:8080"}, {":8080", "127.0.0.1:8080"}, {"[::]:8080", "192.168.1.2:8080"},
		{"localhost:8080", "127.0.0.1:8080"}, {"127.0.0.1:8080", "192.168.1.2:8080"},
		{"127.0.0.1:8080", "[::1]:8080"}, {"unix:///run/x.sock", "unix:///run/x.sock"},
	} {
		if !sameListener(pair[0], pair[1]) || !sameListener(pair[1], pair[0]) {
			t.Errorf("%s and %s: no clash", pair[0], pair[1])
		}
	}
	for _, pair := range [][2]string{
		{":8080", ":8081"}, {"127.0.0.1:8080", "127.0.0.1:8081"},
		{"unix:///run/x.sock", "unix:///run/y.sock"}, {"unix:///run/x.sock", ":8080"},
	} {
		if sameListener(pair[0], pair[1]) {
			t.Errorf("%s and %s: a clash", pair[0], pair[1])
		}
	}
}

// TestClash checks that every address of both serves is compared, and that port 0 never clashes.
func TestClash(t *testing.T) {
	if addr, ok := clash([]string{"127.0.0.1:9001", ":9002"}, []string{"localhost:9000", "[::1]:9002"}); !ok || addr != ":9002" {
		t.Errorf("a second address on a taken port: %q %v", addr, ok)
	}
	if _, ok := clash([]string{"127.0.0.1:9001"}, []string{":9000", ":9003"}); ok {
		t.Error("different ports clash")
	}
	if _, ok := clash([]string{"127.0.0.1:0"}, []string{"localhost:0"}); ok {
		t.Error("port 0 clashes")
	}
	if got := (serve{addr: ":9000"}).listens(); len(got) != 1 || got[0] != ":9000" {
		t.Errorf("a serve without its list listens on %v", got)
	}
}

// TestHTTPServe checks that an http serve child accepts connections on the port that the parent
// picked and Start returned at once. It stops on a Stop.
func TestHTTPServe(t *testing.T) {
	f := newFixture(t)
	began := time.Now()
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(began) > time.Second || v.State != children.StatusStarting || v.Type != "http" || strings.HasSuffix(v.Addr, ":0") {
		t.Fatalf("answered %+v after %v", v, time.Since(began))
	}
	if got := f.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) || got.Addr != v.Addr {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	resp, err := http.Get("http://" + v.Addr + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "a.txt") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	list := f.s.List()
	if len(list) != 1 || list[0].State != children.StatusRunning || list[0].PID == 0 || list[0].Addr != v.Addr ||
		list[0].Args.Addr != v.Addr {
		t.Fatalf("list %+v", list)
	}
	if b := f.s.Busy(false); len(b) != 1 || b[0] != (BusyServe{ID: v.ID, Type: "http", Source: v.Source, Addr: v.Addr}) {
		t.Fatalf("busy %+v", b)
	}
	if b := f.s.Busy(true); len(b) != 1 || !b[0].Back {
		t.Fatalf("busy %+v", b)
	}

	// Try the same address again, written the same way or as every interface, and with
	// something else listening there.
	_, port, _ := net.SplitHostPort(v.Addr)
	for _, addr := range []string{v.Addr, ":" + port, "0.0.0.0:" + port, "localhost:" + port, "[::1]:" + port} {
		if _, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: addr}); !errs.Is(err) ||
			!strings.Contains(err.Error(), "A serve of Rclone UI listens on") {
			t.Fatalf("the same address twice, as %s: %v", addr, err)
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	if _, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: ln.Addr().String()}); !errs.Is(err) {
		t.Fatalf("an address in use: %v", err)
	}

	if err := f.s.Stop(f.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	f.ev.waitN(t, v.ID, 1, children.StatusStopped)
	if answers(context.Background(), v.Addr) || len(f.s.List()) != 0 {
		t.Fatal("still serving after the stop")
	}
	if err := f.s.Stop(f.ctx, v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second stop: %v", err)
	}
	if len(f.notes.get()) != 0 {
		t.Fatalf("notified %+v", f.notes.get())
	}
}

// TestServePasswordOffTheCommandLine checks that a serve's password reaches its child, which
// asks for it, through the child's environment. It never appears on the command line, which any
// local user can read, or anywhere in children.json, including the form recorded to start the
// serve again. The password is stored in the keychain under the serve's id.
func TestServePasswordOffTheCommandLine(t *testing.T) {
	const pass = "hunter2-off-argv"
	f := newFixture(t)
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0",
		Options: groupsOf("serve", `{"user": "me", "pass": "`+pass+`"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	get := func(user, pass string) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, "http://"+v.Addr+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		if user != "" {
			req.SetBasicAuth(user, pass)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if code := get("", ""); code != http.StatusUnauthorized {
		t.Fatalf("without credentials: %d", code)
	}
	if code := get("me", pass); code != http.StatusOK {
		t.Fatalf("with them: %d", code)
	}
	var doc struct{ Children []children.Record }
	b, err := os.ReadFile(filepath.Join(f.run, "children.json"))
	if err != nil || json.Unmarshal(b, &doc) != nil || len(doc.Children) != 1 || strings.Contains(string(b), pass) {
		t.Fatalf("children.json (%v):\n%s", err, b)
	}
	var m meta
	if err := json.Unmarshal(doc.Children[0].Meta, &m); err != nil || !m.Secrets || m.Args.Addr != v.Addr ||
		m.Args.Options.Serve["user"] == nil {
		t.Fatalf("meta (%v): %s", err, doc.Children[0].Meta)
	}
	if kept := f.secrets.all(); len(kept) != 1 || !strings.Contains(kept[secretAccount(v.ID)], pass) {
		t.Fatalf("keychain %v", kept)
	}
	if runtime.GOOS == "windows" {
		return
	}
	pid := f.s.List()[0].PID
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "serve http") || strings.Contains(string(out), pass) {
		t.Fatalf("the child's command line: %s", out)
	}
}

// TestServeVFSCache checks that a serve's VFS cache is in the folder for its address,
// <cache>/serves/<16 hex>.
func TestServeVFSCache(t *testing.T) {
	f := newFixture(t)
	src := f.folder()
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "webdav", Source: src, Addr: "127.0.0.1:0",
		Options: groupsOf("vfs", `{"vfs_cache_mode":"writes"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	r := f.s.RC(v.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stats, err := r.Call(ctx, "vfs/stats", nil)
	if err != nil {
		t.Fatal(err)
	}
	disk, _ := stats["diskCache"].(map[string]any)
	want := cacheFolder(filepath.Join(f.data, "cache"), v.Addr)
	// On Windows rclone names the folder in the long form that it opens (`\\?\C:\x`).
	path, _ := disk["path"].(string)
	if !strings.HasPrefix(strings.TrimPrefix(path, `\\?\`), filepath.Join(want, "vfs")) {
		t.Fatalf("vfs/stats = %v, want a disk cache in %s\n%s", stats, want, f.lines.dump())
	}
	if line := f.lines.cacheRefused(); line != "" {
		t.Fatalf("the serve's VFS cache was refused: %s", line)
	}
	if filepath.Base(filepath.Dir(want)) != "serves" || len(filepath.Base(want)) != 16 ||
		cacheFolder(filepath.Join(f.data, "cache"), "127.0.0.1:1") == want {
		t.Fatalf("cache folder %s", want)
	}
}

// TestServeFails checks that a serve whose child exits before accepting connections fails with
// the child's error, and that serve.failed is sent.
func TestServeFails(t *testing.T) {
	f := newFixture(t)
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: "nosuchremote:dir", Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	got := f.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed)
	if got.State != string(children.StatusFailed) || !strings.Contains(got.Error, "nosuchremote") {
		t.Fatalf("got %+v", got)
	}
	n := f.notes.get()
	if len(n) != 1 {
		t.Fatalf("notified %+v", n)
	}
	if p := n[0].(notifications.ServeFailed); p.Type != "http" || p.Addr != v.Addr || p.Source != "nosuchremote:dir" || p.Error != got.Error {
		t.Fatalf("payload %+v", p)
	}
	if len(f.s.List()) != 0 {
		t.Fatalf("list %+v", f.s.List())
	}
}

// TestServeCrash checks that a crashed serve is started again on the same address, and that
// serve.failed is sent once for the streak.
func TestServeCrash(t *testing.T) {
	f := newFixture(t)
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	f.ev.waitN(t, v.ID, 1, children.StatusRunning)
	for i := 1; i <= 2; i++ {
		p, err := os.FindProcess(f.s.List()[0].PID)
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Kill(); err != nil {
			t.Fatal(err)
		}
		f.ev.waitN(t, v.ID, i, children.StatusRestarting)
		f.ev.waitN(t, v.ID, i+1, children.StatusRunning)
	}
	if n := f.notes.get(); len(n) != 1 {
		t.Fatalf("notified %d times", len(n))
	}
	if !answers(context.Background(), v.Addr) {
		t.Fatal("not serving on its address after the restarts")
	}
}

// TestServeCrashPortTaken checks that before a crashed serve starts again, its address is
// checked. While another program listens there, each start fails with "Something already
// listens on {addr}.", and the serve keeps trying until the address is free again.
func TestServeCrashPortTaken(t *testing.T) {
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.backoff = children.Backoff{Min: 500 * time.Millisecond, Max: 500 * time.Millisecond, Reset: time.Hour}
	}})
	v, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	f.ev.waitN(t, v.ID, 1, children.StatusRunning)
	p, err := os.FindProcess(f.s.List()[0].PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	f.ev.waitN(t, v.ID, 1, children.StatusRestarting)
	ln, err := net.Listen("tcp", v.Addr)
	if err != nil {
		t.Fatal(err)
	}
	// The first start after the crash finds the address taken, and the serve doesn't run.
	got := f.ev.waitN(t, v.ID, 2, children.StatusRestarting)
	if want := "Something already listens on " + v.Addr + "."; got.Error != want {
		t.Fatalf("got %+v, want restarting with %q", got, want)
	}
	if f.ev.count(v.ID, children.StatusRunning) != 1 {
		t.Fatal("the serve ran while another program listened on its address")
	}
	_ = ln.Close()
	f.ev.waitN(t, v.ID, 2, children.StatusRunning)
	if err := f.s.Stop(f.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
}

// TestServeRemotesChanged checks that a serve whose remote changed says so until it starts
// again, and that the other serves don't.
func TestServeRemotesChanged(t *testing.T) {
	f := newFixture(t)
	a, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: t.TempDir(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	f.ev.waitN(t, a.ID, 1, children.StatusRunning)
	f.ev.waitN(t, b.ID, 1, children.StatusRunning)
	f.s.RemotesChanged(func(source string) bool { return source == a.Source })
	restart := map[string]bool{}
	for _, v := range f.s.List() {
		restart[v.ID] = v.Restart
	}
	if !restart[a.ID] || restart[b.ID] {
		t.Fatalf("restart %v", restart)
	}
	var pid int
	for _, v := range f.s.List() {
		if v.ID == a.ID {
			pid = v.PID
			if !Row(v).Restart {
				t.Fatalf("row %+v", Row(v))
			}
		}
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	// The flag was published with the running state, so this is the third running event.
	f.ev.waitN(t, a.ID, 3, children.StatusRunning)
	for _, v := range f.s.List() {
		if v.Restart {
			t.Fatalf("%s is still flagged after it started again", v.ID)
		}
	}
}

// TestServeRestore checks that after a planned restart, the serves come back on their address.
func TestServeRestore(t *testing.T) {
	first := newFixture(t)
	v, err := first.s.Start(first.ctx, operations.ServeArgs{Type: "webdav", Source: first.folder(), Addr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	if got := first.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, first.lines.dump())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := first.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
		t.Fatal(err)
	}
	lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: first.run})
	if len(lo.Restore) != 1 {
		t.Fatalf("restore %+v", lo.Restore)
	}
	next := newFixture(t, fixtureOpts{pending: lo.Restore, run: first.run, data: first.data, db: first.db})
	next.s.Boot(next.ctx)
	if len(next.sup.Pending()) != 0 {
		t.Fatalf("still pending %+v", next.sup.Pending())
	}
	list := next.s.List()
	if len(list) != 1 || list[0].ID != v.ID || list[0].Addr != v.Addr || list[0].Type != "webdav" {
		t.Fatalf("list %+v", list)
	}
	if got := next.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, next.lines.dump())
	}
}

// TestServeRestoreWithPassword checks that a serve with a password comes back after a planned
// restart with its password, which only the keychain stored. The keychain deletes it once the
// serve is stopped, and a quit deletes it too. A record whose password is missing isn't started
// without it.
func TestServeRestoreWithPassword(t *testing.T) {
	const pass = "hunter2-in-the-keychain"
	first := newFixture(t)
	args := operations.ServeArgs{Type: "http", Source: first.folder(), Addr: "127.0.0.1:0",
		Options: groupsOf("serve", `{"user": "me", "pass": "`+pass+`"}`)}
	v, err := first.s.Start(first.ctx, args)
	if err != nil {
		t.Fatal(err)
	}
	if got := first.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, first.lines.dump())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := first.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
		t.Fatal(err)
	}
	first.s.Shutdown(true)
	lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: first.run})
	if len(lo.Restore) != 1 || strings.Contains(string(lo.Restore[0].Meta), pass) {
		t.Fatalf("restore %+v", lo.Restore)
	}

	next := newFixture(t, fixtureOpts{pending: lo.Restore, run: first.run, data: first.data, db: first.db, secrets: first.secrets})
	next.s.Boot(next.ctx)
	if got := next.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, next.lines.dump())
	}
	status := func(user, pass string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, "http://"+v.Addr+"/", nil)
		req.SetBasicAuth(user, pass)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if a, b := status("me", "wrong"), status("me", pass); a != http.StatusUnauthorized || b != http.StatusOK {
		t.Fatalf("a wrong password: %d, the right one: %d", a, b)
	}
	if err := next.s.Stop(next.ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if kept := next.secrets.all(); len(kept) != 0 {
		t.Fatalf("kept after the stop: %v", kept)
	}

	// A quit deletes the password of a serve that is still running.
	w, err := next.s.Start(next.ctx, args)
	if err != nil {
		t.Fatal(err)
	}
	next.ev.waitN(t, w.ID, 1, children.StatusRunning, children.StatusFailed)
	if len(next.secrets.all()) != 1 {
		t.Fatalf("not kept: %v", next.secrets.all())
	}
	if err := next.sup.StopAll(ctx, nil); err != nil {
		t.Fatal(err)
	}
	next.s.Shutdown(false)
	if kept := next.secrets.all(); len(kept) != 0 {
		t.Fatalf("kept after a quit: %v", kept)
	}

	// The password is missing, so the serve isn't started without it.
	raw, _ := json.Marshal(meta{Args: operations.ServeArgs{Type: "http", Source: t.TempDir(), Addr: "127.0.0.1:1"}, Secrets: true})
	rec := children.Record{ID: "0123abcd", Kind: children.KindServe, Name: "http:127.0.0.1:1", Addr: "127.0.0.1:1", Args: []string{"serve"}, Meta: raw}
	last := newFixture(t, fixtureOpts{pending: []children.Record{rec}})
	last.s.Boot(last.ctx)
	if len(last.s.List()) != 0 || len(last.sup.Pending()) != 0 {
		t.Fatalf("list %+v, pending %+v", last.s.List(), last.sup.Pending())
	}
}

// TestLockedConfig checks that a serve from a config file with an unknown password is refused
// before anything starts, and that the error names the file.
func TestLockedConfig(t *testing.T) {
	f := newFixture(t)
	f.configs.err = errors.New("the config is encrypted: enter its password")
	_, err := f.s.Start(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	var ce *children.ConfigError
	if !errors.As(err, &ce) || ce.Path != f.config || len(f.s.List()) != 0 {
		t.Fatalf("got %v, list %+v", err, f.s.List())
	}
}

// TestBootDuringShutdown checks that a serve from the previous run that Boot can't start,
// because the app is shutting down again, doesn't count as a failure. Nothing is notified, and
// the record that StopAll kept stays.
func TestBootDuringShutdown(t *testing.T) {
	raw, _ := json.Marshal(meta{Args: operations.ServeArgs{Type: "http", Source: t.TempDir(), Addr: "127.0.0.1:1"}})
	rec := children.Record{ID: "0123abcd", Kind: children.KindServe, Name: "http:127.0.0.1:1", Addr: "127.0.0.1:1", Args: []string{"serve"}, Meta: raw}
	f := newFixture(t, fixtureOpts{pending: []children.Record{rec}})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := f.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
		t.Fatal(err)
	}
	f.s.Boot(f.ctx)
	if n := f.notes.get(); len(n) != 0 {
		t.Fatalf("notified %+v", n)
	}
	if p := f.sup.Pending(); len(p) != 1 || p[0].ID != rec.ID {
		t.Fatalf("pending %+v, want the record StopAll kept", p)
	}
}

// TestSlowStop checks that a stop that takes longer than its wait returns the error, and still
// removes the serve once its child has exited. The serve leaves the list, a stopped event is
// sent, and its address is free again.
func TestSlowStop(t *testing.T) {
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) { o.stopWait = time.Nanosecond }})
	args := operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"}
	v, err := f.s.Start(f.ctx, args)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.ev.waitN(t, v.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	if err := f.s.Stop(f.ctx, v.ID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stop: %v, want its wait exceeded", err)
	}
	f.ev.waitN(t, v.ID, 1, children.StatusStopped)
	if len(f.s.List()) != 0 {
		t.Fatalf("list %+v", f.s.List())
	}
	if err := f.s.Stop(f.ctx, v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second stop: %v", err)
	}
	args.Addr = v.Addr
	again, err := f.s.Start(f.ctx, args)
	if err != nil {
		t.Fatalf("serving on the same address again: %v", err)
	}
	if got := f.ev.waitN(t, again.ID, 1, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
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
