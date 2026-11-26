//go:build !windows

package update

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// The new UI mustn't start while the old one still holds the single-instance lock, because it
// would pass its arguments to the old one and exit.
const waitScript = `i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; shift; `

const execScript = `exec "$1"`

func relaunchAfterExit(script string, args ...string) func() error {
	return func() error { return relaunchAfter(os.Getpid(), script, args...) }
}

func relaunchAfter(pid int, script string, args ...string) error {
	argv := append([]string{"-c", waitScript + script, "sh", strconv.Itoa(pid)}, args...)
	cmd := exec.Command("/bin/sh", argv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
