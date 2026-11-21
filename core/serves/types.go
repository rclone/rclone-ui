package serves

import (
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/operations"
)

type Serve struct {
	ID     string
	Type   string
	Source string // as entered in the form
	// Addr is where the serve listens, with port 0 replaced by the port the app picked.
	Addr string
	Args operations.ServeArgs // the form it was started with, with its address resolved
	PID  int                  // the serve's process while it runs
	// State is starting (its address doesn't accept connections yet), running (it accepts
	// connections) or restarting. Failed and stopped are reported once, in serves.changed, as
	// the serve leaves the list.
	State children.Status
	Error error // why the serve last went down, nil while it runs
	// Restart is true when a remote it serves changed after it started (RemotesChanged).
	Restart bool
}

// BusyServe is a serve in the busy check. It shows what a quit or an update would stop, and
// whether the serve comes back after an update's restart.
type BusyServe struct {
	ID, Type, Source, Addr string
	Back                   bool
}
