package browse_test

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// progress keeps the progress that scans sent, by request.
type progress struct {
	mu   sync.Mutex
	sent map[string][]browse.UsageProgress
}

func (p *progress) emit(_ context.Context, name string, data any) {
	if name != browse.EventUsage {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	u := data.(browse.UsageProgress)
	p.sent[u.Request] = append(p.sent[u.Request], u)
}

func (p *progress) last(request string) (browse.UsageProgress, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sent[request]
	if len(s) == 0 {
		return browse.UsageProgress{}, false
	}
	return s[len(s)-1], true
}

// ended waits for request's scan to end and returns its last progress.
func (p *progress) ended(t *testing.T, request string) browse.UsageProgress {
	t.Helper()
	var last browse.UsageProgress
	testutil.Eventually(t, 10*time.Second, "the scan to end", func() bool {
		var ok bool
		last, ok = p.last(request)
		return ok && last.State != browse.UsageScanning
	})
	return last
}

func usageAPI() (*browse.API, *progress) {
	p := &progress{sent: map[string][]browse.UsageProgress{}}
	return browse.NewAPI(late.Of(browse.NewLister()), p.emit), p
}

// scan starts a scan of path and returns a function that cancels its call, as the page does,
// and waits for the call to return its error. Calling it again returns the same error.
func scan(a *browse.API, request, path string) (release func() error) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Usage(ctx, request, path) }()
	var (
		once sync.Once
		err  error
	)
	return func() error {
		once.Do(func() {
			cancel()
			select {
			case err = <-done:
			case <-time.After(10 * time.Second):
				err = errors.New("the call didn't return")
			}
		})
		return err
	}
}

func TestUsageScansARemote(t *testing.T) {
	ctx := context.Background()
	fx := &browse.Fixture{Inner: browse.MakeTree(t, map[string]string{
		"photos/2024/a.jpg": "0123456789",
		"photos/b.jpg":      "01234",
		"notes.txt":         "abc",
	})}
	root := browse.AddFixture(fx)
	a, p := usageAPI()
	release := scan(a, "r1", root+"photos/2024") // a folder deep down: the whole remote is scanned
	defer func() { _ = release() }()
	if got, err := a.UsageRoot(ctx, root+"photos/2024"); err != nil || got != root {
		t.Fatalf("the root of a folder deep down: %q %v", got, err)
	}
	end := p.ended(t, "r1")
	if end.State != browse.UsageDone || end.Root != root || end.Local || end.EndedAt == 0 {
		t.Fatalf("end %+v", end)
	}
	if c := end.Count; c.Bytes != 18 || c.Files != 3 || c.Folders != 2 {
		t.Fatalf("count %+v", c)
	}
	level, err := a.UsageLevel(ctx, "r1", "", browse.BySize, 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range level.Rows {
		got = append(got, r.Path)
	}
	if !slices.Equal(got, []string{root + "photos", root + "notes.txt"}) {
		t.Fatalf("rows %q", got)
	}
	if err := a.UsageForget(ctx, "r1", "photos/2024", true); err != nil {
		t.Fatal(err)
	}
	if after, _ := p.last("r1"); after.Count.Bytes != 8 || after.State != browse.UsageDone || after.EndedAt != end.EndedAt {
		t.Fatalf("the progress sent again after a delete: %+v", after)
	}
	level, _ = a.UsageLevel(ctx, "r1", "photos", browse.BySize, 0)
	if level.Total.Bytes != 5 || len(level.Rows) != 1 {
		t.Fatalf("photos after forgetting 2024: %+v", level)
	}
	if _, err := a.UsageLevel(ctx, "r1", "photos/2024", browse.BySize, 0); code(err) != errs.CodeNotFound {
		t.Fatalf("a forgotten folder: %v", err)
	}

	// Once the page lets go of the call, the scan is gone.
	if err := release(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.UsageLevel(ctx, "r1", "", browse.BySize, 0); code(err) != errs.CodeNotFound {
		t.Fatalf("a released scan: %v", err)
	}
}

// TestUsageReadsWhileItScans checks that a page can read a scan before it ends, and that Stop
// ends the walk and keeps what it found.
func TestUsageReadsWhileItScans(t *testing.T) {
	ctx := context.Background()
	entered := make(chan struct{})
	var once sync.Once
	fx := &browse.Fixture{Inner: browse.MakeTree(t, map[string]string{"fast/a": "12345", "slow/b": "1"}), Hook: func(ctx context.Context, dir string) error {
		if dir == "slow" {
			once.Do(func() { close(entered) })
			return browse.Sleep(ctx, time.Minute)
		}
		return nil
	}}
	a, p := usageAPI()
	release := scan(a, "r2", browse.AddFixture(fx))
	defer func() { _ = release() }()
	<-entered
	testutil.Eventually(t, 5*time.Second, "the fast folder to be read during the scan", func() bool {
		level, err := a.UsageLevel(ctx, "r2", "fast", browse.BySize, 0)
		return err == nil && level.Total.Bytes == 5
	})
	if last, _ := p.last("r2"); last.State != browse.UsageScanning {
		t.Fatalf("state %s during the scan", last.State)
	}
	if err := a.UsageStop(ctx, "r2"); err != nil {
		t.Fatal(err)
	}
	end := p.ended(t, "r2")
	if end.State != browse.UsageStopped || end.Count.Bytes != 5 || end.Count.Unread != 0 {
		t.Fatalf("end %+v", end)
	}
	if _, err := a.UsageLevel(ctx, "r2", "", browse.BySize, 0); err != nil {
		t.Fatalf("a stopped scan is kept: %v", err)
	}
}

func TestUsageReturnsTheErrorWhenNothingCouldBeRead(t *testing.T) {
	a, _ := usageAPI()
	err := a.Usage(context.Background(), "r3", ":browsetest,id=nothing:")
	if err == nil {
		t.Fatal("a remote that doesn't open was scanned")
	}
	if err := a.Usage(context.Background(), "r4", ""); code(err) != errs.CodeInvalid {
		t.Fatalf("no path: %v", err)
	}
}

// TestUsageKeepsTheNewestScans checks that a third scan lets go of the oldest one, because a page
// that reloads can't cancel the call it made.
func TestUsageKeepsTheNewestScans(t *testing.T) {
	ctx := context.Background()
	root := browse.AddFixture(&browse.Fixture{Inner: browse.MakeTree(t, map[string]string{"a": "1"})})
	a, p := usageAPI()
	var releases []func() error
	for _, r := range []string{"old", "mid", "new"} {
		releases = append(releases, scan(a, r, root))
		p.ended(t, r)
	}
	defer func() {
		for _, release := range releases {
			_ = release()
		}
	}()
	if _, err := a.UsageLevel(ctx, "old", "", browse.BySize, 0); code(err) != errs.CodeNotFound {
		t.Fatalf("the oldest scan: %v", err)
	}
	for _, r := range []string{"mid", "new"} {
		if _, err := a.UsageLevel(ctx, r, "", browse.BySize, 0); err != nil {
			t.Fatalf("scan %s: %v", r, err)
		}
	}
}

// code returns the code that a page receives with err.
func code(err error) errs.Code {
	if e := errs.Of(err); e != nil {
		return e.Code
	}
	return ""
}
