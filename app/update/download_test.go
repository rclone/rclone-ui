package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDownload(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	content := artifactBytes(kind)
	f.stable = f.release("4.0.2", "v1.76.2", kind, content)
	e := engineFor(f.options(t, "4.0.1"), it, "/x")
	rel, err := e.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var calls int
	var lastDone, lastTotal int64
	art, err := e.Download(context.Background(), rel, func(done, total int64) {
		calls++
		lastDone, lastTotal = done, total
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(art.Path)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("artifact = %d bytes, %v", len(got), err)
	}
	if art.Kind != kind || art.Release != rel {
		t.Errorf("artifact = %+v", art)
	}
	if calls < 2 || lastDone != int64(len(content)) || lastTotal != int64(len(content)) {
		t.Errorf("progress: %d calls, last %d/%d", calls, lastDone, lastTotal)
	}

	// SaveAs into a folder keeps the file name, and the staging folder ends up empty.
	out := t.TempDir()
	dst, err := art.SaveAs(out)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dst) != out {
		t.Errorf("SaveAs put it at %s", dst)
	}
	if b, _ := os.ReadFile(dst); !bytes.Equal(b, content) {
		t.Error("SaveAs changed the file")
	}
}

// A download that isn't the kind of file the feed says fails, and leaves nothing behind.
func TestDownloadRejects(t *testing.T) {
	it, kind := nativeType()
	for _, c := range []struct {
		name string
		body []byte
	}{
		{"wrong kind", []byte("PK\x03\x04 a zip")},
		{"empty", []byte{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFeed(t)
			f.stable = f.release("4.0.2", "", kind, c.body)
			opts := f.options(t, "4.0.1")
			e := engineFor(opts, it, "/x")
			rel, err := e.Check(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := e.Download(context.Background(), rel, nil); err == nil {
				t.Fatal("Download succeeded")
			}
			// Nothing is left behind.
			entries, _ := os.ReadDir(opts.StagingDir)
			if len(entries) != 0 {
				t.Errorf("staging holds %d entries", len(entries))
			}
		})
	}
}

// A download gets its own private folder, whatever the staging folder already holds. A folder
// that another user left there (here, one this user can't write to) changes nothing.
func TestStagingDirIsFresh(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "", kind, artifactBytes(kind))
	opts := f.options(t, "4.0.1")
	if err := os.Mkdir(filepath.Join(opts.StagingDir, "rcui-update"), 0o500); err != nil {
		t.Fatal(err)
	}
	e := engineFor(opts, it, "/x")
	rel, err := e.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	art, err := e.Download(context.Background(), rel, nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(art.Path)
	if filepath.Dir(dir) != opts.StagingDir || !strings.HasPrefix(filepath.Base(dir), "rcui-update-4.0.2-") {
		t.Errorf("downloaded into %s", dir)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Errorf("the folder's mode is %v, want 0700", info.Mode().Perm())
	}
}

// Progress is reported at most every 100 ms, and once more when the last byte is in. Otherwise a
// 4 MB download arriving over 160 ms would make over a hundred calls (one per 32 KB).
func TestProgressThrottled(t *testing.T) {
	it, kind := nativeType()
	content := append(artifactBytes(kind), bytes.Repeat([]byte("x"), 4<<20)...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		const parts = 16
		step := (len(content) + parts - 1) / parts
		for i := 0; i < len(content); i += step {
			_, _ = w.Write(content[i:min(i+step, len(content))])
			w.(http.Flusher).Flush()
			time.Sleep(10 * time.Millisecond)
		}
	}))
	defer srv.Close()
	e := engineFor(Options{HTTPClient: srv.Client(), StagingDir: t.TempDir()}, it, "/x")
	rel := &Release{Version: "4.0.2", Kind: kind, URL: srv.URL + "/a"}
	var calls int
	var lastDone, lastTotal int64
	if _, err := e.Download(context.Background(), rel, func(done, total int64) {
		calls++
		lastDone, lastTotal = done, total
	}); err != nil {
		t.Fatal(err)
	}
	n := int64(len(content))
	if calls < 2 || calls > 10 || lastDone != n || lastTotal != n {
		t.Errorf("progress: %d calls, the last %d/%d; want 2 to 10, the last %d/%d", calls, lastDone, lastTotal, n, n)
	}
}

// A server that stops sending partway through the body fails the download once nothing has
// arrived for stallTimeout, instead of keeping it at "downloading" forever. A slow server that
// keeps sending doesn't fail it.
func TestDownloadStalls(t *testing.T) {
	saved := stallTimeout
	stallTimeout = 300 * time.Millisecond
	t.Cleanup(func() { stallTimeout = saved })

	it, kind := nativeType()
	content := artifactBytes(kind)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		if r.URL.Path == "/slow" {
			// The whole body takes longer than stallTimeout, but never pauses that long.
			for i := 0; i < len(content); i += 1000 {
				_, _ = w.Write(content[i:min(i+1000, len(content))])
				w.(http.Flusher).Flush()
				time.Sleep(stallTimeout / 4)
			}
			return
		}
		_, _ = w.Write(content[:100])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	staging := t.TempDir()
	e := engineFor(Options{HTTPClient: srv.Client(), StagingDir: staging}, it, "/x")

	start := time.Now()
	_, err := e.Download(context.Background(), &Release{Version: "4.0.2", Kind: kind, URL: srv.URL + "/stalled"}, nil)
	if !errors.Is(err, errStalled) {
		t.Fatalf("Download = %v, want errStalled", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("the stall was noticed after %v", d)
	}
	if entries, _ := os.ReadDir(staging); len(entries) != 0 {
		t.Errorf("staging holds %d entries", len(entries))
	}

	if _, err := e.Download(context.Background(), &Release{Version: "4.0.2", Kind: kind, URL: srv.URL + "/slow"}, nil); err != nil {
		t.Errorf("a slow download: %v", err)
	}
}
