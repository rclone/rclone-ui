//go:build !windows

package rclone

import (
	"errors"
	"syscall"
)

func diskFull(err error) bool { return errors.Is(err, syscall.ENOSPC) }
