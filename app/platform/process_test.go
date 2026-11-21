package platform

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

// helperEnv marks the copy of this test program that TestWaitForExit starts as its child.
const helperEnv = "RCUI_PLATFORM_TEST_CHILD"

// TestMain lets the test program run as TestWaitForExit's child: it says that it runs, then
// lives until its input closes.
func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) != "" {
		_, _ = os.Stdout.WriteString("ready\n")
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// WaitForExit returns when the process exits, not before, and without waiting for its limit.
//
// The child is this test program, and it exits when the test closes its input. So the test
// decides when the child ends, and nothing depends on how long a program takes to start or to
// sleep: on a busy machine, a shell asked to sleep for 300 ms can take many seconds.
func TestWaitForExit(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stdin.Close(); _ = cmd.Process.Kill() })
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("the child said %q, %v", line, err)
	}

	// limit is far longer than anything here takes, so a return before it means the exit was
	// seen, and a return after it means it wasn't.
	const limit = 2 * time.Minute
	returned := make(chan time.Duration, 1)
	began := time.Now()
	go func() {
		WaitForExit(cmd.Process.Pid, limit)
		returned <- time.Since(began)
	}()
	select {
	case took := <-returned:
		t.Fatalf("returned after %v while the process still runs", took)
	case <-time.After(300 * time.Millisecond):
	}

	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("the child ended with %v", err)
	}
	if took := <-returned; took >= limit {
		t.Fatalf("waited %v, its whole limit, for a process that had exited", took)
	}

	// This process doesn't exit, so the wait ends at its limit.
	began = time.Now()
	WaitForExit(os.Getpid(), 200*time.Millisecond)
	if took := time.Since(began); took < 150*time.Millisecond {
		t.Fatalf("returned after %v for a running process", took)
	}
}
