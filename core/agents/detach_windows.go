package agents

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// detach makes cmd outlive the process that starts it: it gets a process group of its own and no
// console, so the agent's client closing the bridge doesn't close the app.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
}
