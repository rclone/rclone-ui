package assets

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/klauspost/compress/zstd"
)

func zst(t *testing.T, s string) []byte {
	t.Helper()
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	return enc.EncodeAll([]byte(s), nil)
}

func TestCompressedHandler(t *testing.T) {
	tree := fstest.MapFS{
		"index.html.zst":          {Data: zst(t, "<html>app</html>")},
		"assets/main-1a2b.js.zst": {Data: zst(t, "console.log(1)")},
		"icon.png":                {Data: []byte("\x89PNG\r\n\x1a\nraw")},
	}
	h := newCompressed(tree, time.Now())
	cases := []struct {
		path, body, ctype string
		code              int
	}{
		{"/", "<html>app</html>", "text/html; charset=utf-8", 200},
		{"/settings", "<html>app</html>", "text/html; charset=utf-8", 200},
		{"/templates/", "<html>app</html>", "text/html; charset=utf-8", 200},
		{"/assets/main-1a2b.js", "console.log(1)", "text/javascript; charset=utf-8", 200},
		{"/icon.png", "\x89PNG\r\n\x1a\nraw", "image/png", 200},
		{"/missing.js", "", "", 404},
	}
	for _, c := range cases {
		for range 2 { // each request decompresses the file again
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
			body, _ := io.ReadAll(rec.Body)
			if rec.Code != c.code {
				t.Errorf("%s: code %d, want %d", c.path, rec.Code, c.code)
				continue
			}
			if c.code != 200 {
				continue
			}
			if string(body) != c.body || rec.Header().Get("Content-Type") != c.ctype {
				t.Errorf("%s: %q (%s), want %q (%s)", c.path, body, rec.Header().Get("Content-Type"), c.body, c.ctype)
			}
		}
	}
}

func TestCompressedFolderIsARoute(t *testing.T) {
	tree := fstest.MapFS{
		"index.html.zst":                {Data: zst(t, "<html>app</html>")},
		"icons/providers/drive.svg.zst": {Data: zst(t, "<svg/>")},
	}
	h := newCompressed(tree, time.Now())
	for _, path := range []string{"/icons", "/icons/", "/icons/providers"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if body, _ := io.ReadAll(rec.Body); rec.Code != 200 || string(body) != "<html>app</html>" {
			t.Errorf("%s: %d %q", path, rec.Code, body)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope.js", nil))
	if rec.Code != 404 {
		t.Errorf("/nope.js: %d", rec.Code)
	}
}

func TestStoredFileRange(t *testing.T) {
	tree := fstest.MapFS{"clip.mp4": {Data: []byte("0123456789")}}
	h := newCompressed(tree, time.Now())
	req := httptest.NewRequest(http.MethodGet, "/clip.mp4", nil)
	req.Header.Set("Range", "bytes=2-5")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if body, _ := io.ReadAll(rec.Body); rec.Code != http.StatusPartialContent || string(body) != "2345" {
		t.Errorf("%d %q", rec.Code, body)
	}
}

func TestContentTypeSniffs(t *testing.T) {
	if got := ContentType("LICENSE", []byte("plain words")); !strings.HasPrefix(got, "text/plain") {
		t.Errorf("sniffed %q", got)
	}
}
