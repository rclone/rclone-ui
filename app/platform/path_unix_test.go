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

// TestReadLoginPathOwnSession uses a fake shell that prints its process group instead of PATH.
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
	shell := filepath.Join(t.TempDir(), "fakeshell")
	script := "#!/bin/sh\n(sleep 3) &\nprintf '__RCUI_PATH__/opt/fake/bin__RCUI_PATH__'\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	path, ok := readLoginPath(shell)
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("took %v", took)
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
