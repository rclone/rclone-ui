package cloudflared

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"
)

// metricsServer stands in for cloudflared's metrics server. The hostname appears first, and the
// connection a moment later.
func metricsServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/quicktunnel":
			_, _ = fmt.Fprint(w, `{"hostname":"abc-def.trycloudflare.com"}`)
		case "/ready":
			if time.Since(began) < 500*time.Millisecond {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// TestWaitServed checks that the address is returned once the tunnel is connected, and that
// cloudflared ending first returns its error.
func TestWaitServed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	host, err := waitServed(ctx, metricsServer(t), make(chan error))
	if err != nil || host != "abc-def.trycloudflare.com" {
		t.Fatalf("%q %v", host, err)
	}

	done := make(chan error, 1)
	done <- errors.New("failed to request quick Tunnel")
	if _, err := waitServed(ctx, "127.0.0.1:1", done); err == nil {
		t.Fatal("no error for a cloudflared that ended")
	}
}
