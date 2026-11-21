package mounts

// A real mount child on macOS uses NFS, which needs nothing installed.
import _ "github.com/rclone/rclone/cmd/nfsmount"
