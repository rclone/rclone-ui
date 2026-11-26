package children

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"

	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/vfs/vfscache/writeback"

	"github.com/rclone/rclone-ui/core/internal/ids"
)

const maxRCResponse = 64 << 20

type RC struct {
	sock, user, pass string
	hc               *http.Client
}

func newRC(sock string) *RC {
	return &RC{
		sock: sock,
		user: ids.Hex(8),
		pass: ids.Hex(16),
		hc: &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sock)
			},
			DisableKeepAlives: true,
			Proxy:             nil,
		}},
	}
}

func (r *RC) Credentials() (user, pass string) { return r.user, r.pass }

type RCError struct {
	Path    string
	Status  int
	Message string
}

func (e *RCError) Error() string {
	return fmt.Sprintf("rc %s: %s (HTTP %d)", e.Path, e.Message, e.Status)
}

func (r *RC) Call(ctx context.Context, path string, in rc.Params) (rc.Params, error) {
	var out rc.Params
	if err := r.callInto(ctx, path, in, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *RC) callInto(ctx context.Context, path string, in rc.Params, out any) error {
	if in == nil {
		in = rc.Params{}
	}
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://child/"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(r.user, r.pass)
	resp, err := r.hc.Do(req)
	if err != nil {
		return fmt.Errorf("rc %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxRCResponse))
	if err != nil {
		return fmt.Errorf("rc %s: %w", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		// rclone's rc returns an error as {"error": …} (fs/rc/rcserver writeError).
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		if e.Error == "" {
			e.Error = http.StatusText(resp.StatusCode)
		}
		return &RCError{Path: path, Status: resp.StatusCode, Message: e.Error}
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("rc %s: %w", path, err)
	}
	return nil
}

func (r *RC) VFSQueue(ctx context.Context) ([]writeback.QueueInfo, error) {
	var out struct {
		Queue []writeback.QueueInfo `json:"queue"`
	}
	if err := r.callInto(ctx, "vfs/queue", nil, &out); err != nil {
		return nil, err
	}
	return out.Queue, nil
}
