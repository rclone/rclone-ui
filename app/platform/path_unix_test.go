//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestReadLoginPathOwnSession(t *testing.T) {
	shell := filepath.Join(t.TempDir(), "fakeshell")
	script := "#!/bin/sh\nprintf '__RCUI_PATH__%s__RCUI_PATH__' \"$(ps -o pgid= -p $$)\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	out, ok := readLoginPath(shell)
	if !ok {
		t.Skip("ps printed nothing")
	}
	pgid, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		t.Skipf("ps printed %q", out)
	}
	if pgid == syscall.Getpgrp() {
		t.Fatalf("the shell is in the app's process group %d", pgid)
	}
}

func TestReadLoginPathBackgroundJob(t *testing.T) {
	dir := t.TempDir()
	shell := filepath.Join(dir, "fakeshell")
	pidFile := filepath.Join(dir, "job.pid")
	script := "#!/bin/sh\nsleep 30 &\necho $! > '" + pidFile + "'\nprintf '__RCUI_PATH__/opt/fake/bin__RCUI_PATH__'\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if b, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
	start := time.Now()
	path, ok := readLoginPath(shell)
	if took := time.Since(start); took > 15*time.Second {
		t.Errorf("took %v: the read waited for the shell's background job", took)
	}
	if !ok || path != "/opt/fake/bin" {
		t.Fatalf("%q %v", path, ok)
	}
}

func TestReadLoginPathNoMarkers(t *testing.T) {
	shell := filepath.Join(t.TempDir(), "fakeshell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\necho welcome\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if path, ok := readLoginPath(shell); ok {
		t.Fatalf("%q", path)
	}
}
