//go:build linux || darwin

package children

import "path/filepath"

// resolvedMountPoint returns a mount point as the OS's mount table writes it, with the symlinks
// in its parent resolved (macOS lists /private/tmp/x for /tmp/x). The mount point itself is never
// touched, because touching a dead NFS mount hangs the caller.
func resolvedMountPoint(mountPoint string) string {
	mp := filepath.Clean(mountPoint)
	parent, err := filepath.EvalSymlinks(filepath.Dir(mp))
	if err != nil {
		return mp
	}
	return filepath.Join(parent, filepath.Base(mp))
}
