//go:build cmount

package mounts

// A real mount child on Windows uses WinFsp through cmount (-tags cmount).
import _ "github.com/rclone/rclone/cmd/cmount"
