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

const pathMarker = "__RCUI_PATH__"

// Finder and desktop launchers start apps with a minimal PATH.
func FixPath() {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	if path, ok := readLoginPath(shell); ok {
		_ = os.Setenv("PATH", path)
	}
}

// A profile may start a background job without redirecting its output, which keeps the output
// open after the shell has exited.
func readLoginPath(shell string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := HostCommand(ctx, shell, "-ilc", `printf '`+pathMarker+`%s`+pathMarker+`' "$PATH"`)
	// Without its own session, an interactive shell started from a terminal would take over the
	// terminal's foreground for its job control, and keep it.
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
