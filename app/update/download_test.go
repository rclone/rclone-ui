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
			entries, _ := os.ReadDir(opts.StagingDir)
			if len(entries) != 0 {
				t.Errorf("staging holds %d entries", len(entries))
			}
		})
	}
}

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
	start := time.Now()
	if _, err := e.Download(context.Background(), rel, func(done, total int64) {
		calls++
		lastDone, lastTotal = done, total
	}); err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	n := int64(len(content))
	most := 2 + int(took/progressEvery)
	if calls < 2 || calls > most || lastDone != n || lastTotal != n {
		t.Errorf("progress: %d calls in %v, the last %d/%d; want 2 to %d, the last %d/%d", calls, took, lastDone, lastTotal, most, n, n)
	}
}

func TestDownloadStalls(t *testing.T) {
	saved := stallTimeout
	t.Cleanup(func() { stallTimeout = saved })
	const slowStall = 2 * time.Second

	it, kind := nativeType()
	content := artifactBytes(kind)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		if r.URL.Path == "/slow" {
			began, rest := time.Now(), content
			for time.Since(began) <= slowStall && len(rest) > 1 {
				_, _ = w.Write(rest[:1])
				w.(http.Flusher).Flush()
				rest = rest[1:]
				time.Sleep(slowStall / 40)
			}
			_, _ = w.Write(rest)
			return
		}
		_, _ = w.Write(content[:100])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	staging := t.TempDir()
	e := engineFor(Options{HTTPClient: srv.Client(), StagingDir: staging}, it, "/x")

	stallTimeout = 300 * time.Millisecond
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

	stallTimeout = slowStall
	if _, err := e.Download(context.Background(), &Release{Version: "4.0.2", Kind: kind, URL: srv.URL + "/slow"}, nil); err != nil {
		t.Errorf("a slow download: %v", err)
	}
}
