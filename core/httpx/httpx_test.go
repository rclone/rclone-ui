package httpx

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorder is a test server that replies with its name and records the requests it gets.
type recorder struct {
	*httptest.Server
	name string
	mu   sync.Mutex
	seen []string // method and request target of each request
}

func newRecorder(name string) *recorder {
	rec := &recorder{name: name}
	rec.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		rec.seen = append(rec.seen, r.Method+" "+r.RequestURI)
		rec.mu.Unlock()
		if r.Method == http.MethodConnect {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, name)
	}))
	return rec
}

func (r *recorder) requests() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.seen...)
}

// proxy is the environment's proxy for this test process. It is set before anything reads it,
// because Go reads it once per process. This mirrors how rclone.Init sets the proxy from Settings
// in the core.
var proxy *recorder

func TestMain(m *testing.M) {
	proxy = newRecorder("proxy")
	for k, v := range map[string]string{
		"HTTP_PROXY":  proxy.URL,
		"HTTPS_PROXY": proxy.URL,
		"NO_PROXY":    "direct.test,.corp.test,10.0.0.0/8,*.inner",
	} {
		if err := os.Setenv(k, v); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	code := m.Run()
	proxy.Close()
	os.Exit(code)
}

func TestClientTakesTheEnvironmentsProxy(t *testing.T) {
	target := newRecorder("target")
	t.Cleanup(target.Close)
	targetAddr := strings.TrimPrefix(target.URL, "http://")

	// Made-up hosts reach the target server when dialed directly. A proxied request dials the
	// proxy's own loopback address instead.
	base := baseTransport()
	var dialer net.Dialer
	base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if strings.HasSuffix(addr, ".test:80") {
			addr = targetAddr
		}
		return dialer.DialContext(ctx, network, addr)
	}
	client := &http.Client{Transport: base, Timeout: 5 * time.Second}

	get := func(u string) (string, error) {
		resp, err := client.Get(u)
		if err != nil {
			return "", err
		}
		defer func() { _ = resp.Body.Close() }()
		body, err := io.ReadAll(resp.Body)
		return string(body), err
	}
	expect := func(u, want string) {
		t.Helper()
		got, err := get(u)
		if err != nil {
			t.Fatalf("GET %s: %v", u, err)
		}
		if got != want {
			t.Errorf("GET %s answered by %s, want %s", u, got, want)
		}
	}

	expect("http://target.test/a", "proxy")
	expect("http://direct.test/b", "target")
	expect("http://api.corp.test/c", "target")
	if got := proxy.requests(); len(got) != 1 || got[0] != "GET http://target.test/a" {
		t.Errorf("the proxy saw %q", got)
	}

	// https goes through the same proxy, with CONNECT.
	if _, err := get("https://secure.test/"); err == nil {
		t.Error("the CONNECT refused by the proxy did not fail the request")
	}
	if got := proxy.requests(); len(got) != 2 || got[1] != "CONNECT secure.test:443" {
		t.Errorf("the proxy saw %q", got)
	}
	if got := target.requests(); strings.Join(got, ",") != "GET /b,GET /c" {
		t.Errorf("the target saw %q", got)
	}
}

func TestProxyExceptions(t *testing.T) {
	proxyFor := New(0).Transport.(*http.Transport).Proxy
	for _, c := range []struct {
		url    string
		direct bool
	}{
		{"http://example.com/", false},
		{"https://example.com/", false},
		{"http://direct.test/", true},
		{"http://10.1.2.3/", true},
		{"http://a.inner/", true},
		{"http://localhost:8080/", true},
		{"http://127.0.0.1/", true},
	} {
		u, _ := url.Parse(c.url)
		got, err := proxyFor(&http.Request{URL: u})
		if err != nil {
			t.Fatalf("%s: %v", c.url, err)
		}
		if direct := got == nil; direct != c.direct {
			t.Errorf("%s: proxy %v, want direct %v", c.url, got, c.direct)
		}
	}
}

func TestNewUsesTheTimeout(t *testing.T) {
	c := New(15 * time.Second)
	if c.Timeout != 15*time.Second {
		t.Errorf("Timeout = %v", c.Timeout)
	}
	if c.Transport == nil || c.Transport == http.DefaultTransport {
		t.Error("the client has no transport of its own")
	}
}

// TestDevRedirect: a development run can send a host's requests to a local server, which keeps
// their path and query. Other hosts are reached as usual.
func TestDevRedirect(t *testing.T) {
	stand := newRecorder("stand-in")
	defer stand.Close()
	direct := newRecorder("direct")
	defer direct.Close()
	t.Setenv("RCUI_DEV_REDIRECT", "api.telegram.org="+stand.URL)
	c := New(5 * time.Second)
	for _, u := range []string{"https://api.telegram.org/bot1:a/sendMessage?x=1", direct.URL + "/y"} {
		resp, err := c.Post(u, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	if got := strings.Join(stand.seen, ";"); got != "POST /bot1:a/sendMessage?x=1" {
		t.Errorf("stand-in got %q", got)
	}
	if got := strings.Join(direct.seen, ";"); got != "POST /y" {
		t.Errorf("direct got %q", got)
	}
}
