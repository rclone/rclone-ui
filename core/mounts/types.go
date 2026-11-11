package mounts

import (
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/operations"
)

type Mount struct {
	ID     string
	Source string // as entered in the form
	// MountPoint is where the remote is mounted. For a Windows `*`, it is the drive the app picked.
	MountPoint string
	PID        int // the mount's process while it runs
	// State is starting (not in the mount table yet), running (listed in the mount table) or
	// restarting. Failed and stopped are reported once, in mounts.changed, as the mount leaves
	// the list.
	State children.Status
	Error error // why the mount last went down, nil while it runs
	// UploadsPending is the size of the upload queue (vfs/queue). ListUploads reads it, and it is
	// 0 in List.
	UploadsPending int
	Automount      bool // started as an automount
	// Restart is true when a remote it mounts changed after it started (RemotesChanged).
	Restart bool
}

// StoppedMount is a stopped mount whose cache still holds uploads. The Mount page lists it with
// the Mount again and Discard actions.
type StoppedMount struct {
	Folder     string // the 16 hex characters of cache/vfs/<16 hex>
	Source     string
	MountPoint string
	Args       operations.MountArgs
	Pending    *int64 // files waiting, when known
}

// Automount is a mount that the app starts each time it starts, as the Automounts window edits
// it: a folder of a remote (RemotePath, "" for its root), the mount point, and the Mount form's
// option groups (mount, vfs, filter, config, metadata). A remote can have several.
type Automount struct {
	ID         string            `json:"id"`
	Remote     string            `json:"remote"`
	RemotePath string            `json:"remotePath"`
	MountPoint string            `json:"mountPoint"`
	Options    operations.Groups `json:"options"`
	Enabled    bool              `json:"enabled"`
	CreatedAt  int64             `json:"createdAt"`
}

// args returns the automount's Mount form, with `<remote>:<remote path>` as the source. An empty
// path means the remote's root.
func (m Automount) args() operations.MountArgs {
	return operations.MountArgs{Source: m.Remote + ":" + m.RemotePath, Destination: m.MountPoint, Options: m.Options}
}

// AutomountRow is an automount as the Automounts window lists it, with what the window shows
// about it now.
type AutomountRow struct {
	Automount
	// MountID is the running mount that it started, or that mounts the same source at the same
	// place, or "" when it isn't mounted.
	MountID string `json:"mountId"`
	// RemoteMissing is set when its remote isn't in the config, or the config is locked. It
	// isn't mounted at start then.
	RemoteMissing bool `json:"remoteMissing"`
}

// BusyMount is a mount in the busy check. It shows what an update would stop, how many uploads
// the mount still has queued, and whether it comes back after the restart.
type BusyMount struct {
	ID             string
	Source         string
	MountPoint     string
	UploadsPending int
	Back           bool
}
