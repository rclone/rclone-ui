package browse

import (
	"context"
	"strings"
	"testing"

	_ "github.com/rclone/rclone/backend/http"

	"github.com/rclone/rclone-ui/core/internal/late"
)

// TestAFatalRemoteIsTheReadsError checks that a fatal rclone error only fails the read. The
// remote's override gives a client cert without its key, so rclone's HTTP client calls
// fs.Fatalf. The read fails, and the core keeps running.
func TestAFatalRemoteIsTheReadsError(t *testing.T) {
	_, err := testAPI().PublicLink(context.Background(), ":http,url='http://127.0.0.1:9/',override.client_cert='/nonexistent.pem':file.txt")
	if err == nil || !strings.Contains(err.Error(), "client-key") {
		t.Fatalf("got %v", err)
	}
}

// testAPI returns an API that discards its events.
func testAPI() *API { return NewAPI(late.Of(NewLister()), func(context.Context, string, any) {}) }
