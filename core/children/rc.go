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

// maxRCResponse limits how much of one rc response the parent reads (vfs/queue can be large
// during a big upload).
const maxRCResponse = 64 << 20

// RC calls a rclone child's rc over its unix socket, using the child's basic-auth credentials
// (RCLONE_RC_USER and RCLONE_RC_PASS in its environment).
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
			// A restarted child listens again on the same path, so no connection is kept
			// between calls.
			DisableKeepAlives: true,
			Proxy:             nil,
		}},
	}
}

// Credentials returns the child's rc user and password. The tunnel (`rcui tunnel`) serves its rc
// on a public address as well as on its socket, with the same credentials, and the pairing QR
// code carries them.
func (r *RC) Credentials() (user, pass string) { return r.user, r.pass }

type RCError struct {
	Path    string
	Status  int
	Message string
}

func (e *RCError) Error() string {
	return fmt.Sprintf("rc %s: %s (HTTP %d)", e.Path, e.Message, e.Status)
}

// Call posts in to the rc path and decodes the response. ctx limits the call. vfs/stats walks
// the whole tree, so give it the time it needs.
func (r *RC) Call(ctx context.Context, path string, in rc.Params) (rc.Params, error) {
	var out rc.Params
	if err := r.callInto(ctx, path, in, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// callInto posts in to the rc path and decodes the response into out, which is a pointer to
// rclone's type for that response (or to rc.Params).
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

// VFSQueue returns the mount's pending uploads (vfs/queue). The list is empty when the mount's
// cache mode is off.
func (r *RC) VFSQueue(ctx context.Context) ([]writeback.QueueInfo, error) {
	var out struct {
		Queue []writeback.QueueInfo `json:"queue"`
	}
	if err := r.callInto(ctx, "vfs/queue", nil, &out); err != nil {
		return nil, err
	}
	return out.Queue, nil
}
