//go:build !windows

package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The relaunch waits for the process to exit, then runs its script with its arguments.
func TestRelaunchAfterExit(t *testing.T) {
	sleep := exec.Command("sleep", "0.5")
	if err := sleep.Start(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	// Reap the process as soon as it exits, because a zombie still answers kill -0.
	go func() { _ = sleep.Wait() }()
	out := filepath.Join(t.TempDir(), "out")
	if err := relaunchAfter(sleep.Process.Pid, `printf %s "$2" > "$1"`, out, "a b"); err != nil {
		t.Fatal(err)
	}
	b := waitForFile(t, out, 5*time.Second)
	if d := time.Since(start); d < 400*time.Millisecond {
		t.Errorf("the script ran after %v, before the process exited", d)
	}
	if string(b) != "a b" {
		t.Errorf("the script got %q, want %q", b, "a b")
	}
}

// waitForFile returns file's contents once it has some.
func waitForFile(t *testing.T, file string, limit time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(limit)
	for {
		if b, err := os.ReadFile(file); err == nil && len(b) > 0 {
			return b
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s wasn't written within %v", file, limit)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
