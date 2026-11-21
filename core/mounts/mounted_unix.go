//go:build linux || darwin

package mounts

import "github.com/rclone/rclone-ui/core/children"

// mounted reports whether the OS mount table lists the mount point. It never touches the mount
// itself. Linux reads /proc/self/mountinfo, and macOS calls getfsstat with MNT_NOWAIT, so a dead
// NFS mount can't make it hang.
func mounted(mountPoint string) (bool, error) { return children.Mounted(mountPoint) }

// drivesInUse returns 0, because only Windows has drive letters.
func drivesInUse() uint32 { return 0 }
