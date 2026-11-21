package media

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

func TestAllowedOrigin(t *testing.T) {
	for origin, want := range map[string]bool{
		"wails://localhost":       true,
		"http://wails.localhost":  true,
		"http://localhost:9245":   false,
		"http://127.0.0.1:5173":   false,
		"http://localhost:3000":   false,
		"https://evil.example":    false,
		"wails://localhost.evil":  false,
		"http://localhost.evil:1": false,
		"":                        false,
	} {
		if got := allowedOrigin(origin); got != want {
			t.Errorf("allowedOrigin(%q) = %v, want %v", origin, got, want)
		}
	}
}

// The pages of a development run are allowed on the dev server's port, whichever it is.
func TestDevOrigins(t *testing.T) {
	for devURL, want := range map[string][]string{
		"": nil,
		"http://localhost:1431": {"wails://localhost:1431", "http://wails.localhost:1431", "https://wails.localhost:1431",
			"http://localhost:1431", "http://127.0.0.1:1431"},
		"http://[::1]:9245": {"wails://localhost:9245", "http://wails.localhost:9245", "https://wails.localhost:9245",
			"http://localhost:9245", "http://127.0.0.1:9245", "http://[::1]:9245"},
		"http://devbox": {"http://devbox"},
		"not a url":     nil,
	} {
		if got := devOrigins(devURL); !slices.Equal(got, want) {
			t.Errorf("devOrigins(%q) = %v, want %v", devURL, got, want)
		}
	}
	t.Setenv("FRONTEND_DEVSERVER_URL", "http://localhost:1431")
	for origin, want := range map[string]bool{
		"wails://localhost:1431": true,
		"http://localhost:1431":  true,
		"wails://localhost:9245": false,
		"wails://localhost":      true,
	} {
		if got := allowedOrigin(origin); got != want {
			t.Errorf("with a dev server, allowedOrigin(%q) = %v, want %v", origin, got, want)
		}
	}
}

// A preflight request for a range read is answered only for the app's pages.
func TestPreflight(t *testing.T) {
	h := cors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	for origin, want := range map[string]string{"wails://localhost": "wails://localhost", "https://evil.example": ""} {
		pre := httptest.NewRequest(http.MethodOptions, "/media?p=x", nil)
		pre.Header.Set("Origin", origin)
		pre.Header.Set("Access-Control-Request-Method", "GET")
		pre.Header.Set("Access-Control-Request-Headers", "range")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, pre)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != want {
			t.Errorf("%s: allowed %q, want %q", origin, got, want)
		}
		if want != "" && (rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Headers") != "Range") {
			t.Errorf("%s: %d %v", origin, rec.Code, rec.Header())
		}
	}
}
