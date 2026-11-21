//go:build !windows

package agents

import (
	"os/exec"
	"syscall"
)

// detach makes cmd outlive the process that starts it: it gets a session of its own, so the
// agent's client closing the bridge doesn't close the app.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
