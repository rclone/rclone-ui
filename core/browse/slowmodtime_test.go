package browse

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/rclone/gofakes3"
	"github.com/rclone/gofakes3/s3mem"
	_ "github.com/rclone/rclone/backend/s3"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/object"
)

type countingS3 struct {
	mu     sync.Mutex
	counts map[string]int
	url    string
}

func newCountingS3(t *testing.T, buckets ...string) *countingS3 {
	t.Helper()
	mem := s3mem.New()
	for _, b := range buckets {
		if err := mem.CreateBucket(context.Background(), b); err != nil {
			t.Fatal(err)
		}
	}
	c := &countingS3{counts: map[string]int{}}
	fake := gofakes3.New(mem).Server()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.counts[r.Method]++
		c.mu.Unlock()
		fake.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	c.url = srv.URL
	return c
}

func (c *countingS3) remote(bucket string) string {
	return fmt.Sprintf(":s3,provider=Other,endpoint=%q,access_key_id=k,secret_access_key=s,force_path_style=true:%s", c.url, bucket)
}

func (c *countingS3) reset() {
	c.mu.Lock()
	c.counts = map[string]int{}
	c.mu.Unlock()
}

func (c *countingS3) heads() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.counts[http.MethodHead]
}

func (c *countingS3) put(t *testing.T, bucket string, names ...string) {
	t.Helper()
	ctx := context.Background()
	f, err := fs.NewFs(ctx, c.remote(bucket))
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	for _, n := range names {
		body := []byte("content of " + n)
		info := object.NewStaticObjectInfo(n, at, int64(len(body)), true, nil, f)
		if _, err := f.Put(ctx, bytes.NewReader(body), info); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNoRequestPerFileForModTimes(t *testing.T) {
	s3 := newCountingS3(t, "left", "right")
	var names []string
	for i := range 30 {
		names = append(names, fmt.Sprintf("dir/file%02d.txt", i))
	}
	s3.put(t, "left", names...)
	s3.put(t, "right", "dir/other.txt")
	ctx := context.Background()

	s3.reset()
	rows, _, err := fetch(ctx, s3.remote("left"), "dir", 1000, false, func([]Entry) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 30 || s3.heads() != 0 {
		t.Errorf("listing: %d rows, %d HEAD requests", len(rows), s3.heads())
	}
	for _, r := range rows {
		if r.ModTime != "" {
			t.Errorf("listing: %s has the time %s", r.Path, r.ModTime)
		}
	}

	s3.reset()
	var found []Entry
	if err := Search(ctx, s3.remote("left"), "", "file1", 1000, false, false, func(es []Entry) { found = append(found, es...) }); err != nil {
		t.Fatal(err)
	}
	if len(found) != 10 || s3.heads() != 0 {
		t.Errorf("search: %d found, %d HEAD requests", len(found), s3.heads())
	}

	// Opening a path below a bucket checks once whether it is a file. That is one request per
	// side, whatever the number of files, so the remotes are opened before counting.
	for _, side := range []string{"left", "right"} {
		if _, err := getFs(ctx, s3.remote(side)+"/dir"); err != nil {
			t.Fatal(err)
		}
	}
	s3.reset()
	cmp, err := Compare(ctx, s3.remote("left")+"/dir", s3.remote("right")+"/dir", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(cmp.Pairs) != 31 || s3.heads() != 0 {
		t.Errorf("compare: %d pairs, %d HEAD requests", len(cmp.Pairs), s3.heads())
	}

	l := NewLister()
	if _, err := l.List(ctx, s3.remote("left"), "dir", false, false, 1000, func([]Entry) {}); err != nil {
		t.Fatal(err)
	}
	s3.reset()
	rows = nil
	if _, err := l.List(ctx, s3.remote("left"), "dir", false, true, 1000, func(es []Entry) { rows = append(rows, es...) }); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 30 || s3.heads() != 30 || rows[0].ModTime == "" {
		t.Errorf("with dates: %d rows, %d HEAD requests, first time %q", len(rows), s3.heads(), rows[0].ModTime)
	}
	s3.reset()
	if _, err := l.List(ctx, s3.remote("left"), "dir", false, true, 1000, func([]Entry) {}); err != nil || s3.counts[http.MethodGet] != 0 || s3.heads() != 0 {
		t.Errorf("cached listing with dates: %v, %v", s3.counts, err)
	}

	local := MakeTree(t, map[string]string{"a.txt": "a"})
	rows, _, err = fetch(ctx, local, "", 10, false, func([]Entry) {})
	if err != nil || len(rows) != 1 || rows[0].ModTime == "" {
		t.Errorf("local listing: %+v, %v", rows, err)
	}
}

func TestServerModTimesAreShown(t *testing.T) {
	s3 := newCountingS3(t, "bucket")
	s3.put(t, "bucket", "a.txt", "b.txt")
	ctx, ci := fs.AddConfig(context.Background())
	ci.UseServerModTime = true

	s3.reset()
	// Another bucket name than the other test's, so rclone's cache doesn't hand back an Fs made
	// without the setting.
	rows, _, err := fetch(ctx, s3.remote("bucket"), "", 10, false, func([]Entry) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || s3.heads() != 0 || rows[0].ModTime == "" {
		t.Errorf("rows %+v, %d HEAD requests", rows, s3.heads())
	}
}
