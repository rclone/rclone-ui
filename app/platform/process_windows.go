package platform

import (
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// DetachedProcess starts a process in its own process group, without a console.
func DetachedProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

func WaitForExit(pid int, limit time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return // the process has already exited, or we may not wait for it
	}
	defer func() { _ = windows.CloseHandle(h) }()
	_, _ = windows.WaitForSingleObject(h, uint32(limit/time.Millisecond))
}
