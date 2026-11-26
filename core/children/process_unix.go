//go:build unix

package children

import (
	"errors"
	"os"
	"syscall"
)

func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

type osState struct{}

func (*osState) afterStart(int) error { return nil }

// terminate sends SIGTERM to the child's group. rclone unmounts when it gets SIGTERM.
func terminate(p *os.Process) error { return signalGroup(p.Pid, syscall.SIGTERM) }

func kill(p *os.Process) error { return signalGroup(p.Pid, syscall.SIGKILL) }

func killGroup(pid int) { _ = syscall.Kill(-pid, syscall.SIGKILL) }

func killLeftover(pid int) error {
	gerr := syscall.Kill(-pid, syscall.SIGKILL)
	perr := syscall.Kill(pid, syscall.SIGKILL)
	if gerr == nil || perr == nil || errors.Is(perr, syscall.ESRCH) {
		return nil
	}
	return perr
}

func signalGroup(pid int, sig syscall.Signal) error {
	err := syscall.Kill(-pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
