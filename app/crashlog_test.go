package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestKeepCrashes runs the test binary again, to crash it with a panic on another goroutine.
func TestKeepCrashes(t *testing.T) {
	if dir := os.Getenv("RCUI_TEST_CRASH_DIR"); dir != "" {
		keepCrashes(dir)
		go panic("the crash this test expects")
		// The crash must be the child's only way out. If the test returned here, the child could
		// exit with success before the panic ends it.
		select {}
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "crash.log")
	crash := func() string {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestKeepCrashes$")
		cmd.Env = append(os.Environ(), "RCUI_TEST_CRASH_DIR="+dir)
		if err := cmd.Run(); err == nil {
			t.Fatal("the child exited without crashing")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	if got := crash(); strings.Count(got, "panic: the crash this test expects") != 1 {
		t.Fatalf("crash.log should hold the panic once:\n%s", got)
	}
	if got := crash(); strings.Count(got, "panic: the crash this test expects") != 2 {
		t.Fatalf("a second crash should be appended:\n%s", got)
	}

	if err := os.WriteFile(path, []byte(strings.Repeat("x", crashLogLimit+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := crash(); strings.HasPrefix(got, "x") {
		t.Fatalf("a file above the limit should start over, it is %d bytes", len(got))
	}
}
