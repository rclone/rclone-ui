package agents

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/datadir"
)

const startWait = 30 * time.Second

// Bridge returns the process's exit code. Its only output on stdout is the protocol's, so what it
// has to say goes to stderr, where MCP clients show or log it.
func Bridge(args []string, stdin io.ReadCloser, stdout io.WriteCloser, stderr io.Writer) int {
	fs := flag.NewFlagSet("rcui mcp", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("data-dir", "", "the app's data directory (default: the app's own)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *dir == "" {
		d, err := datadir.Default()
		if err != nil {
			fmt.Fprintln(stderr, "rcui mcp: the data folder can't be found:", err)
			return 1
		}
		*dir = d
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	found, err := find(ctx, *dir, args)
	if err != nil {
		fmt.Fprintln(stderr, "rcui mcp:", err)
		return 1
	}
	if err := relay(ctx, found, &mcp.IOTransport{Reader: stdin, Writer: stdout}); err != nil {
		fmt.Fprintln(stderr, "rcui mcp:", err)
		return 1
	}
	return 0
}

func find(ctx context.Context, dir string, args []string) (Found, error) {
	if f, err := readFound(dir); err == nil && answers(ctx, f) {
		return f, nil
	}
	if err := startApp(args); err != nil {
		return Found{}, fmt.Errorf("Rclone UI isn't running, and couldn't be started: %w", err)
	}
	deadline := time.Now().Add(startWait)
	for time.Now().Before(deadline) {
		if f, err := readFound(dir); err == nil && answers(ctx, f) {
			return f, nil
		}
		select {
		case <-ctx.Done():
			return Found{}, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return Found{}, errors.New("Rclone UI isn't letting agents in. Open its Settings, and under Agents turn on \"Let AI agents use Rclone UI\"")
}

func answers(ctx context.Context, f Found) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	return true
}

func startApp(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, append([]string{"ui", "--hidden"}, args...)...)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

type withToken struct{ token string }

func (t withToken) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}

func relay(ctx context.Context, f Found, agent mcp.Transport) error {
	server := &mcp.StreamableClientTransport{Endpoint: f.URL, HTTPClient: &http.Client{Transport: withToken{f.Token}}}
	down, err := agent.Connect(ctx)
	if err != nil {
		return err
	}
	defer down.Close()
	up, err := server.Connect(ctx)
	if err != nil {
		return err
	}
	defer up.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pump := func(from, to mcp.Connection) error {
		for {
			msg, err := from.Read(ctx)
			if err != nil {
				return err
			}
			if err := to.Write(ctx, msg); err != nil {
				return err
			}
		}
	}
	errs := make(chan error, 2)
	go func() { errs <- pump(down, up) }()
	go func() { errs <- pump(up, down) }()
	err = <-errs
	// The agent closing its side is how a session ends.
	if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
