//go:build linux || darwin

package mounts

import "github.com/rclone/rclone-ui/core/children"

func mounted(mountPoint string) (bool, error) { return children.Mounted(mountPoint) }

func drivesInUse() uint32 { return 0 }
