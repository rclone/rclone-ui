//go:build !windows

package childenv

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// sigpipeHelper is the variable that tells the test binary to run as the writing process, and in
// which mode.
const sigpipeHelper = "RCUI_TEST_SIGPIPE"

// TestIgnoreSIGPIPE checks that a process survives writing to stderr after its reader is gone
// when it ignores SIGPIPE, and is killed by SIGPIPE otherwise.
func TestIgnoreSIGPIPE(t *testing.T) {
	if mode, ok := os.LookupEnv(sigpipeHelper); ok {
		if mode == "ignore" {
			IgnoreSIGPIPE()
		}
		_, _ = io.Copy(io.Discard, os.Stdin) // the parent closes stdin once the reader is gone
		_, _ = fmt.Fprintln(os.Stderr, "a line nobody reads")
		os.Exit(0)
	}
	run := func(mode string) error {
		t.Helper()
		errR, errW, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestIgnoreSIGPIPE$")
		cmd.Env = append(os.Environ(), sigpipeHelper+"="+mode)
		cmd.Stderr = errW
		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		_, _ = errW.Close(), errR.Close()
		_ = stdin.Close()
		return cmd.Wait()
	}
	if err := run("ignore"); err != nil {
		t.Fatalf("ignoring SIGPIPE: %v", err)
	}
	if err := run("default"); err == nil || !strings.Contains(err.Error(), "broken pipe") {
		t.Fatalf("without: %v, want the process to die of a broken pipe", err)
	}
}
