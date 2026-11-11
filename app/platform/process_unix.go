//go:build !windows

package platform

import (
	"errors"
	"syscall"
	"time"
)

// DetachedProcess starts a process in its own session, so that it isn't affected when this
// process ends.
func DetachedProcess() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func WaitForExit(pid int, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
