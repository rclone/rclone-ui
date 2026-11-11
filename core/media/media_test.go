package media

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/http"
	_ "github.com/rclone/rclone/backend/local"

	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/rclone"
)

func TestMain(m *testing.M) {
	testutil.Main(m, func(dir string) error {
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, nil, 0o600); err != nil {
			return err
		}
		_, err := rclone.Init(context.Background(), rclone.InitOptions{ConfigPath: conf, CacheDir: filepath.Join(dir, "cache")})
		return err
	})
}

func get(t *testing.T, srv *httptest.Server, u string, header map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+u, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

func TestSignedURLs(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	file := filepath.Join(root, "hello world.txt")
	if err := os.WriteFile(file, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSigner()
	mux := http.NewServeMux()
	mux.Handle(Pattern, s.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u, exp := s.Sign(file, true)
	if time.Until(exp) < Lifetime-time.Minute {
		t.Errorf("expires %v", exp)
	}
	res := get(t, srv, u, nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "0123456789" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "inline; filename*=UTF-8''hello%20world%2Etxt") {
		t.Errorf("disposition %q", cd)
	}
	if res.Header.Get("Content-Security-Policy") != "sandbox" || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/plain") {
		t.Errorf("headers %v", res.Header)
	}

	res = get(t, srv, u, map[string]string{"Range": "bytes=2-4"})
	body, _ = io.ReadAll(res.Body)
	if res.StatusCode != http.StatusPartialContent || string(body) != "234" || res.Header.Get("Content-Range") != "bytes 2-4/10" {
		t.Errorf("range: %d %q %q", res.StatusCode, body, res.Header.Get("Content-Range"))
	}

	// A range past the end is answered by http.ServeContent with 416, without the file's name.
	res = get(t, srv, u, map[string]string{"Range": "bytes=50-60"})
	if res.StatusCode != http.StatusRequestedRangeNotSatisfiable || res.Header.Get("Content-Disposition") != "" {
		t.Errorf("unsatisfiable range: %d %q", res.StatusCode, res.Header.Get("Content-Disposition"))
	}

	// A different path with the same signature is refused, and so is an expired URL.
	tampered := strings.Replace(u, "hello", "other", 1)
	if res := get(t, srv, tampered, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("tampered: %d", res.StatusCode)
	}
	old := s.now
	s.now = func() time.Time { return old().Add(-2 * Lifetime) }
	expired, _ := s.Sign(file, false)
	s.now = old
	if res := get(t, srv, expired, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("expired: %d", res.StatusCode)
	}
	missing, _ := s.Sign(filepath.Join(root, "nope.txt"), false)
	if res := get(t, srv, missing, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("missing: %d", res.StatusCode)
	}
	attach, _ := s.Sign(file, false)
	if cd := get(t, srv, attach, nil).Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("attachment %q", cd)
	}
}

// TestFatalOpeningARemote checks that a remote whose override makes rclone's HTTP client call
// fs.Fatalf (a client cert without its key) only fails that one response, and the app keeps
// running.
func TestFatalOpeningARemote(t *testing.T) {
	s := NewSigner()
	mux := http.NewServeMux()
	mux.Handle(Pattern, s.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()
	u, _ := s.Sign(":http,url='http://127.0.0.1:9/',override.client_cert='/nonexistent.pem':file.txt", false)
	res := get(t, srv, u, nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "client-key") {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
}

// unknownSize serves files over rclone's http backend with no_head, so their size is unknown.
// /whole.bin is sent whole, /broken.bin fails after its first bytes, and /refused.bin fails
// before anything is sent.
func unknownSize(t *testing.T) (*httptest.Server, *Signer, func(name string) string) {
	t.Helper()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/whole.bin":
			_, _ = io.WriteString(w, "0123456789")
		case "/broken.bin":
			// More than the media server buffers, so its response has started.
			w.Header().Set("Content-Length", "200000")
			_, _ = w.Write(make([]byte, 100000))
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		default:
			http.Error(w, "refused", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(origin.Close)
	s := NewSigner()
	mux := http.NewServeMux()
	mux.Handle(Pattern, s.Handler())
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, s, func(name string) string {
		u, _ := s.Sign(":http,url='"+origin.URL+"/',no_head=true:"+name, false)
		return u
	}
}

// A range asked for a file of unknown size gets the whole file, so a player can play it.
func TestUnknownSizeRange(t *testing.T) {
	srv, _, sign := unknownSize(t)
	res := get(t, srv, sign("whole.bin"), map[string]string{"Range": "bytes=0-"})
	body, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != http.StatusOK || string(body) != "0123456789" {
		t.Fatalf("%d %q %v", res.StatusCode, body, err)
	}
}

// A read that fails partway cuts the connection, so the part doesn't look whole.
func TestUnknownSizeFailsPartway(t *testing.T) {
	srv, _, sign := unknownSize(t)
	res := get(t, srv, sign("broken.bin"), nil)
	body, err := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || err == nil {
		t.Fatalf("the read looked complete: %d, %d bytes, %v", res.StatusCode, len(body), err)
	}
}

// A read that fails before anything is sent answers with the error, and the error is never
// saved under the file's name.
func TestUnknownSizeFailsAtOnce(t *testing.T) {
	srv, _, sign := unknownSize(t)
	res := get(t, srv, sign("refused.bin"), nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "500") {
		t.Errorf("%d %q", res.StatusCode, body)
	}
	if cd := res.Header.Get("Content-Disposition"); cd != "" {
		t.Errorf("an error is saved as the file: %q", cd)
	}
}
