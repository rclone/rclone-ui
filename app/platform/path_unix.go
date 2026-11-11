//go:build !windows

package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// pathMarker surrounds the PATH in the shell's output, so that anything a profile prints to
// stdout isn't mixed into the value.
const pathMarker = "__RCUI_PATH__"

// FixPath gives a process launched from the GUI the PATH of the user's login shell. Finder and
// desktop launchers start apps with a minimal PATH, but rclone's password commands and the core's
// children need the user's PATH. When the app is started from a terminal, PATH is already the
// shell's, and this changes nothing that matters. FixPath runs before the app is built, because
// building it reads the environment.
func FixPath() {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if path, ok := readLoginPath(shell); ok {
		_ = os.Setenv("PATH", path)
	}
}

// readLoginPath returns the PATH that shell prints when run as a login shell. A profile may start
// a background job without redirecting its output, such as an agent or `(sleep 60) &`. That job
// keeps the output open after the shell has exited. So the wait for the output is cut short, and
// what the shell printed is used.
func readLoginPath(shell string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Use the host's environment, because under an AppImage the shell would load the AppImage's
	// libraries.
	cmd := HostCommand(ctx, shell, "-ilc", `printf '`+pathMarker+`%s`+pathMarker+`' "$PATH"`)
	// Run the shell in its own session. Otherwise, when the app is started from a terminal, the
	// interactive shell would take over the terminal's foreground for its job control, and keep
	// it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.Output()
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return "", false
	}
	s := string(out)
	start := strings.Index(s, pathMarker)
	if start < 0 {
		return "", false
	}
	s = s[start+len(pathMarker):]
	end := strings.Index(s, pathMarker)
	if end <= 0 {
		return "", false
	}
	return s[:end], true
}
