// Package cloudflared builds cloudflared's quick tunnel into rcui, so the tunnel needs no
// download. `rclone tunnel` (package tunnelcmd) runs it in its own process, in front of its rc
// server, in the same way as `cloudflared tunnel --no-autoupdate --url <origin>`. No other part
// of cloudflared's command line can be reached: not its updater (which would replace rcui), and
// not its service install or Access commands.
package cloudflared

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/cloudflare/cloudflared/cmd/cloudflared/cliutil"
	"github.com/cloudflare/cloudflared/cmd/cloudflared/tunnel"
	"github.com/urfave/cli/v2"

	"github.com/rclone/rclone-ui/core/internal/freeport"
)

// Version is the cloudflared release that is built in. go.mod pins its commit, along with the
// replace directives from cloudflared's own go.mod (its quic-go and urfave/cli forks). Upgrade
// them together.
const Version = "2026.9.3"

// gracePeriod is how long cloudflared lets requests finish once it is asked to stop.
const gracePeriod = "3s"

// Options control how cloudflared logs to stderr.
type Options struct {
	// LogLevel is cloudflared's log level: debug, info, warn or error.
	LogLevel string
	// JSON logs one JSON object per line.
	JSON bool
}

// Tunnel is a quick tunnel that Cloudflare serves.
type Tunnel struct {
	// URL is the tunnel's address on trycloudflare.com.
	URL string
	// Done receives the result when cloudflared ends, either because it stopped on a signal or
	// because it failed.
	Done <-chan error
}

// started is set once a tunnel runs. cloudflared keeps its state in package variables, so a
// process can run only one tunnel.
var started atomic.Bool

// Start runs the quick tunnel to origin in this process. It returns once the tunnel has an
// address and a connection to Cloudflare, or once ctx ends. The tunnel stops with the process.
// cloudflared itself ends on SIGINT or SIGTERM and then closes its shutdown channel, so nothing
// else may close it.
func Start(ctx context.Context, origin string, o Options) (*Tunnel, error) {
	if !started.CompareAndSwap(false, true) {
		return nil, errors.New("cloudflared already runs in this process")
	}
	free, err := freeport.Loopback()
	if err != nil {
		return nil, err
	}
	metrics := free.String()
	argv := []string{
		"cloudflared", "tunnel", "--no-autoupdate",
		"--metrics", metrics, "--grace-period", gracePeriod, "--url", origin,
	}
	if o.LogLevel != "" {
		argv = append(argv, "--loglevel", o.LogLevel)
	}
	if o.JSON {
		argv = append(argv, "--output", "json")
	}
	// This matches what cloudflared's main does.
	_ = os.Setenv("QUIC_GO_DISABLE_ECN", "1")
	tunnel.Init(cliutil.GetBuildInfo("", Version), make(chan struct{}))
	app := &cli.App{
		Name:     "cloudflared",
		Version:  Version,
		Flags:    tunnel.Flags(),
		Commands: tunnel.Commands(),
		// Return errors here, because urfave/cli would otherwise exit the process on some.
		ExitErrHandler: func(*cli.Context, error) {},
	}
	done := make(chan error, 1)
	go func() { done <- app.Run(argv) }()

	host, err := waitServed(ctx, metrics, done)
	if err != nil {
		return nil, err
	}
	return &Tunnel{URL: "https://" + host, Done: done}, nil
}

// waitServed polls cloudflared's metrics server, first for the quick tunnel's hostname, then for
// its first connection to Cloudflare (/ready).
func waitServed(ctx context.Context, metrics string, done <-chan error) (string, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	get := func(path string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+metrics+path, nil)
		if err != nil {
			return nil, err
		}
		return client.Do(req)
	}
	host := ""
	for {
		if host == "" {
			if res, err := get("/quicktunnel"); err == nil {
				var body struct {
					Hostname string `json:"hostname"`
				}
				_ = json.NewDecoder(res.Body).Decode(&body)
				_ = res.Body.Close()
				host = body.Hostname
			}
		} else if res, err := get("/ready"); err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return host, nil
			}
		}
		select {
		case err := <-done:
			if err == nil {
				err = errors.New("it stopped")
			}
			return "", fmt.Errorf("cloudflared: %w", err)
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
