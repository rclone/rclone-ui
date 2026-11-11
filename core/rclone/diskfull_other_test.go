//go:build !windows

package rclone

import "syscall"

var diskFullError error = syscall.ENOSPC
