package mounts

import (
	"errors"
	"io/fs"
	"os"

	"golang.org/x/sys/windows"
)

// mounted reports whether the drive or folder exists. WinFsp creates it when the mount is up and
// removes it when the process ends. Before the mount, the folder doesn't exist, because
// prepareMountPoint removed it.
func mounted(mountPoint string) (bool, error) {
	path := mountPoint
	if len(path) == 2 && path[1] == ':' {
		path += `\`
	}
	_, err := os.Lstat(path)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	}
	return false, err
}

// drivesInUse returns the drives that Windows is using now, with bit 0 for A:. It returns none
// when Windows can't tell. In that case a mount on a taken drive fails, just as cmount's own pick
// could.
func drivesInUse() uint32 {
	used, _ := windows.GetLogicalDrives()
	return used
}
