package remotes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/rclone/rclone/fs/config"
)

// useLinkboxServer redirects the quota request to a local server for a test.
func useLinkboxServer(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	previousURL, previousClient := linkboxInfoURL, linkboxClient
	linkboxInfoURL, linkboxClient = server.URL, server.Client()
	t.Cleanup(func() {
		linkboxInfoURL, linkboxClient = previousURL, previousClient
	})
}

func TestLinkboxAbout(t *testing.T) {
	setup(t, "")
	config.FileSetValue("box", "type", "linkbox")
	config.FileSetValue("box", "web_token", "tok")

	var calls atomic.Int32
	useLinkboxServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.URL.Query().Get("token"); got != "tok" {
			t.Errorf("token = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":{"size_cap":1099,"size_curr":249}}`)
	})

	usage := linkboxAbout(context.Background(), "box")
	if usage == nil {
		t.Fatal("no quota for the linkbox remote")
	}
	if usage.Total == nil || usage.Used == nil || usage.Free == nil ||
		*usage.Total != 1099 || *usage.Used != 249 || *usage.Free != 850 {
		t.Fatalf("quota %+v", usage)
	}
	if calls.Load() != 1 {
		t.Fatalf("%d requests", calls.Load())
	}
}

func TestLinkboxAboutSkipsOtherRemotesAndBadAnswers(t *testing.T) {
	setup(t, "")
	config.FileSetValue("box", "type", "memory")
	config.FileSetValue("box", "web_token", "tok")

	var calls atomic.Int32
	useLinkboxServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "ip incorrect", http.StatusForbidden)
	})

	if usage := linkboxAbout(context.Background(), "box"); usage != nil {
		t.Fatalf("quota for a non-linkbox remote: %+v", usage)
	}
	if calls.Load() != 0 {
		t.Fatalf("a non-linkbox remote made %d requests", calls.Load())
	}

	config.FileSetValue("box", "type", "linkbox")
	if usage := linkboxAbout(context.Background(), "box"); usage != nil {
		t.Fatalf("quota from an error response: %+v", usage)
	}
	if calls.Load() != 1 {
		t.Fatalf("%d requests", calls.Load())
	}
}
