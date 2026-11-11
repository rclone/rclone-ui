// Package rclone wraps rclone as a library. It holds rclone's process-wide setup, the one way
// to call its rc functions (always inside its job runner), the active config file (Store), and
// the reference data that the pages read.
//
// The backends (backend/all) and rclone's commands (cmd/all, lib/plugin) are imported by
// main.go, which also runs them for rclone's CLI and for the mount and serve children. cmd/all
// brings in mount on Linux, nfsmount on macOS and cmount on Windows (with the cmount build tag).
// This package imports only what the in-process rc functions and the option blocks need.
package rclone

import (
	// sync/bisync (cmd/bisync/rc.go).
	_ "github.com/rclone/rclone/cmd/bisync"
	// These packages register their rc functions in their init.
	_ "github.com/rclone/rclone/fs/accounting"
	_ "github.com/rclone/rclone/fs/config"
	_ "github.com/rclone/rclone/fs/operations"
	_ "github.com/rclone/rclone/fs/rc/jobs"
	_ "github.com/rclone/rclone/fs/sync"
	_ "github.com/rclone/rclone/vfs"

	// These register the option blocks for mounts and serves, which core/catalog reads. The
	// pages build their forms from them, even though mounts and serves run in child processes.
	_ "github.com/rclone/rclone/cmd/mountlib"
	_ "github.com/rclone/rclone/cmd/serve/dlna"
	_ "github.com/rclone/rclone/cmd/serve/ftp"
	_ "github.com/rclone/rclone/cmd/serve/http"
	_ "github.com/rclone/rclone/cmd/serve/restic"
	_ "github.com/rclone/rclone/cmd/serve/s3"
	_ "github.com/rclone/rclone/cmd/serve/sftp"
	_ "github.com/rclone/rclone/cmd/serve/webdav"
)
