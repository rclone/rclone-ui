//go:build unix

package children

import (
	"errors"
	"os"
	"syscall"
)

// Every child leads its own process group, so a stop also reaches the processes it started.

// sysProcAttr puts the child in its own process group. It doesn't set Pdeathsig, because a child
// already ends when the core's end of its stdin closes (see childenv), and it unmounts first.
func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

// osState is the supervisor's per-OS state. Unix needs none.
type osState struct{}

func (*osState) afterStart(int) error { return nil }

// terminate sends SIGTERM to the child's group. rclone unmounts when it gets SIGTERM.
func terminate(p *os.Process) error { return signalGroup(p.Pid, syscall.SIGTERM) }

func kill(p *os.Process) error { return signalGroup(p.Pid, syscall.SIGKILL) }

// killGroup kills whatever is left in the group of a child that has exited.
func killGroup(pid int) { _ = syscall.Kill(-pid, syscall.SIGKILL) }

// killLeftover kills a child that an earlier run of the app left behind. It kills the child's
// group, and the pid itself in case the child no longer leads a group.
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
		return nil // already gone
	}
	return err
}
