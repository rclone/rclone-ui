package rclone

import (
	"errors"

	"golang.org/x/sys/windows"
)

// diskFull reports whether err says that the disk has no space left. Windows has two errors for
// it: one for the disk, and one for a file that can't grow.
func diskFull(err error) bool {
	return errors.Is(err, windows.ERROR_DISK_FULL) || errors.Is(err, windows.ERROR_HANDLE_DISK_FULL)
}
