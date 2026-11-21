package serves

import (
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Types returns rclone's list unchanged. This test binary links the http and webdav serves.
func TestTypes(t *testing.T) {
	got := NewAPI(nil).Types()
	if !slices.Equal(got, rclone.ServeTypes()) || !slices.Contains(got, "http") || !slices.Contains(got, "webdav") ||
		!slices.IsSorted(got) {
		t.Errorf("types %v, rclone's %v", got, rclone.ServeTypes())
	}
}

// StartReady returns once the serve answers on its address, and with the child's own words when
// its first start fails.
func TestStartReady(t *testing.T) {
	f := newFixture(t)
	api := NewAPI(late.Of(f.s))
	row, err := api.StartReady(f.ctx, operations.ServeArgs{Type: "http", Source: f.folder(), Addr: "127.0.0.1:0"})
	if err != nil || row.State != string(children.StatusRunning) || strings.HasSuffix(row.Addr, ":0") {
		t.Fatalf("got %+v, %v\n%s", row, err, f.lines.dump())
	}
	resp, err := http.Get("http://" + row.Addr + "/a.txt") // no wait: it answers already
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "a" {
		t.Fatalf("a.txt over http: %q", body)
	}
	if err := api.Stop(f.ctx, row.ID); err != nil {
		t.Fatal(err)
	}

	_, err = api.StartReady(f.ctx, operations.ServeArgs{Type: "http", Source: "nosuchremote:dir", Addr: "127.0.0.1:0"})
	if err == nil || !strings.Contains(err.Error(), "nosuchremote") {
		t.Fatalf("a failed start: %v", err)
	}
}
