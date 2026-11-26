package remotes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestStartDrive(t *testing.T) {
	drives := []string{"b!STALE", "REAL"}
	for _, c := range []struct {
		name, current, me, want string
	}{
		{"the user's own drive", "", "REAL", "REAL"},
		{"the remote's current drive, on an edit", "b!STALE", "REAL", "b!STALE"},
		{"rclone's default, when Graph names no listed drive", "", "OTHER", ""},
		{"rclone's default, when Graph didn't answer", "", "", ""},
		{"the user's own drive, when the current one is gone", "GONE", "REAL", "REAL"},
	} {
		if got := startDrive(drives, c.current, c.me); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestMeDrive(t *testing.T) {
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1.0/me/drive" || r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"id":"REAL","name":"OneDrive","driveType":"personal"}`)
	}))
	defer graph.Close()
	ctx := context.Background()
	if id, err := meDrive(ctx, graph.Client(), graph.URL+"/v1.0", "good"); err != nil || id != "REAL" {
		t.Errorf("good token: %q, %v", id, err)
	}
	if id, err := meDrive(ctx, graph.Client(), graph.URL+"/v1.0", "bad"); err == nil {
		t.Errorf("refused token: %q, no error", id)
	}
	if _, err := meDrive(ctx, graph.Client(), graph.URL+"/v1.0", ""); err == nil {
		t.Error("no token: no error")
	}
}

func TestAccessToken(t *testing.T) {
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	earlier := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	for token, want := range map[string]string{
		`{"access_token":"a","expiry":"` + later + `"}`:   "a",
		`{"access_token":"a","expiry":"` + earlier + `"}`: "",
		`{"access_token":"a"}`:                            "a",
		`not json`:                                        "",
		``:                                                "",
	} {
		if got := accessToken(token); got != want {
			t.Errorf("%s: got %q, want %q", token, got, want)
		}
	}
}
