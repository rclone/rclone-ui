package media

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

// Listen serves the signed URLs on a loopback port until Shutdown.
func (s *Signer) Listen() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	s.base = "http://" + ln.Addr().String()
	mux := http.NewServeMux()
	mux.Handle(Pattern, s.Handler())
	s.srv = &http.Server{Handler: cors(mux), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logs.Logger(logs.CompApp, "media").Error("serving the media URLs stopped", "error", err)
		}
	}()
	return nil
}

// Shutdown stops serving, which ends the previews' reads.
func (s *Signer) Shutdown(ctx context.Context) {
	if s.srv == nil {
		return
	}
	if err := s.srv.Shutdown(ctx); err != nil {
		_ = s.srv.Close()
	}
}

// allowedOrigin reports whether origin is a page of the app. The app's pages are on
// wails://localhost on macOS and Linux, and on http://wails.localhost on Windows. In a
// development run they also load on the dev server's port (see devOrigins). Any other page, such
// as another program's dev server, can't read the responses.
func allowedOrigin(origin string) bool {
	switch origin {
	case "wails://localhost", "http://wails.localhost", "https://wails.localhost":
		return true
	}
	return origin != "" && slices.Contains(devOrigins(devServerURL()), origin)
}

// devOrigins returns the origins of the pages in a development run, where Vite serves them at
// devURL. Wails loads the pages on Vite's port (wails://localhost:9245 for Vite on 9245), and
// Vite's own address works in a browser.
func devOrigins(devURL string) []string {
	u, err := url.Parse(devURL)
	if devURL == "" || err != nil || u.Host == "" {
		return nil
	}
	var origins []string
	if port := u.Port(); port != "" {
		origins = []string{"wails://localhost:" + port, "http://wails.localhost:" + port, "https://wails.localhost:" + port,
			"http://localhost:" + port, "http://127.0.0.1:" + port}
	}
	if own := u.Scheme + "://" + u.Host; !slices.Contains(origins, own) {
		origins = append(origins, own)
	}
	return origins
}

// cors lets the app's pages read the responses with fetch, which a preview uses to read a file
// in ranges. The signature keeps other pages from loading the files, and CORS keeps their scripts
// from reading the responses.
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && allowedOrigin(origin) {
			hd := w.Header()
			hd.Set("Access-Control-Allow-Origin", origin)
			hd.Add("Vary", "Origin")
			hd.Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition, Content-Type")
			// Chromium's private network access check, for a page on another origin that
			// requests 127.0.0.1.
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				hd.Set("Access-Control-Allow-Private-Network", "true")
			}
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				hd.Set("Access-Control-Allow-Methods", "GET, HEAD")
				hd.Set("Access-Control-Allow-Headers", "Range")
				hd.Set("Access-Control-Max-Age", "7200")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}
