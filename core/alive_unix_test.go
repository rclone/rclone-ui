//go:build !windows

package core

import (
	"errors"
	"syscall"
)

// alive reports whether process pid is still running. A zombie that hasn't been waited for
// doesn't count.
func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}
