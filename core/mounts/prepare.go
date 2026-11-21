package mounts

import (
	"errors"
	"io/fs"
	"os"

	"github.com/rclone/rclone-ui/core/errs"
)

var (
	errNotADirectory = errs.New("The mount point is not a folder.")
	errLink          = errs.New("This mount point is a link. A mount needs a folder, not a link to one.")
	errNotEmpty      = errs.New("The selected directory must be empty to mount a remote.")
	errMkdir         = errs.New("The mount point’s folder couldn’t be made. Try making it yourself first.")
	// errNotRemoved is for a Windows mount point that exists and can't be removed, because of an
	// open handle or an ACL. WinFsp would refuse to mount on it, and the mount would just keep
	// restarting.
	errNotRemoved = errs.New("The selected directory could not be removed. On Windows the mount point must not exist yet: remove it, or choose another one.")
)

// prepareMountPoint gets the mount point ready. It refuses a link, which would carry the mount
// to wherever it leads, a file, and a folder that isn't empty (rclone would mount over its
// contents). It creates a missing folder. On Windows it instead removes an empty folder and
// leaves a missing one missing, because WinFsp needs the path to not exist.
func prepareMountPoint(mountPoint string, windows bool) error {
	path := mountPoint
	if windows && len(path) == 2 && path[1] == ':' {
		path += `\` // "D:" alone is the current folder of drive D
	}
	if fi, err := os.Lstat(path); err == nil && isLink(fi, windows) {
		return errLink
	}
	st, err := os.Stat(path)
	if err == nil {
		if !st.IsDir() {
			return errNotADirectory
		}
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) > 0 { // unreadable counts as not empty
			return errNotEmpty
		}
		if windows {
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return errNotRemoved
			}
		}
		return nil
	}
	// The folder is missing or can't be read. Create it, except on Windows.
	if windows {
		return nil
	}
	if err := os.MkdirAll(path, 0o777); err != nil {
		return errMkdir
	}
	return nil
}

// isLink reports whether fi is a symbolic link, or on Windows also a junction, which Go reports
// as irregular.
func isLink(fi os.FileInfo, windows bool) bool {
	return fi.Mode()&os.ModeSymlink != 0 || windows && fi.Mode()&os.ModeIrregular != 0
}
