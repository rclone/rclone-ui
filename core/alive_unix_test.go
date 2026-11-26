//go:build !windows

package core

import (
	"errors"
	"syscall"
)

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}
