package remotes

import (
	"context"
	"sync"
	"testing"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/config/configmap"
)

// slowLogin is the login of the backend "slowlogin", modeled on oauthutil's. It waits for the
// browser and then stores the token. Each test sets it up with its own channels.
var slowLogin struct {
	mu      sync.Mutex
	waiting chan struct{} // signaled when the login starts waiting
	release chan struct{} // closed when the browser approves
}

func init() {
	fs.Register(&fs.RegInfo{
		Name: "slowlogin", Description: "a login that waits for the browser",
		NewFs: func(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
			return nil, fs.ErrorNotImplemented
		},
		Config: func(ctx context.Context, name string, m configmap.Mapper, in fs.ConfigIn) (*fs.ConfigOut, error) {
			slowLogin.mu.Lock()
			waiting, release := slowLogin.waiting, slowLogin.release
			slowLogin.mu.Unlock()
			// Create the job's stats group, as a login's token exchange does.
			accounting.Stats(ctx)
			waiting <- struct{}{}
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			m.Set("token", "account-of-A")
			return nil, nil
		},
	})
}

// armSlowLogin sets up slowlogin's channels. The login waits until release is closed.
func armSlowLogin(t *testing.T) (waiting <-chan struct{}, release chan struct{}) {
	t.Helper()
	w, r := make(chan struct{}, 1), make(chan struct{})
	slowLogin.mu.Lock()
	slowLogin.waiting, slowLogin.release = w, r
	slowLogin.mu.Unlock()
	return w, r
}
