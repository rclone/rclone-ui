package children

// This test binary also runs as every child that the tests start. A rclone child (marked by
// childenv) runs rclone's command line, as main.go dispatches it. `<test binary> helper <mode>`
// is a small program whose behaviour each supervisor test picks. The supervisor starts the helper
// the same way it starts every child: with the mark, and with the flags that every child gets
// after the helper's own arguments.

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/lsf"
	_ "github.com/rclone/rclone/cmd/serve/http"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
)

func TestMain(m *testing.M) {
	// Check for the helper first, because it carries the child's mark too, and rclone doesn't
	// know the `helper` command.
	if len(os.Args) > 1 && os.Args[1] == "helper" {
		os.Exit(helper(os.Args[2:]))
	}
	if _, ok := os.LookupEnv(childenv.Env); ok {
		// A rclone child runs rclone's own main, as main.go's runRclone does.
		childenv.Adopt(OwnMount)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	// The children run with their own home folder.
	testutil.Main(m, nil)
}

// helper is the small child program. Its first argument selects what it does.
func helper(args []string) int {
	if len(args) == 0 {
		return 2
	}
	switch args[0] {
	case "exit": // exit <code>
		code, _ := strconv.Atoi(args[1])
		return code
	case "up-then-exit": // up-then-exit <ms>: runs for that long, then fails
		ms, _ := strconv.Atoi(args[1])
		time.Sleep(time.Duration(ms) * time.Millisecond)
		return 1
	case "fail": // fail <line>: prints the line on stderr, then fails
		fmt.Fprintln(os.Stderr, args[1])
		return 1
	case "sleep":
		select {}
	case "err-then-sleep": // err-then-sleep <line>: prints the line on stderr, then runs on
		fmt.Fprintln(os.Stderr, args[1])
		select {}
	case "env": // env <key>: prints the variable's value
		v, ok := os.LookupEnv(args[1])
		fmt.Println(args[1], v, ok)
		return 0
	case "ignore-term": // ignores SIGTERM, so the stop must kill it
		signal.Ignore(syscall.SIGTERM)
		fmt.Println("ready")
		select {}
	case "print": // prints a line on each pipe, and an error line on SIGTERM, as Temporal does
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGTERM)
		fmt.Println("hello from stdout")
		fmt.Fprintln(os.Stderr, "hello from stderr")
		<-c
		fmt.Fprintln(os.Stderr, "ERROR shutting down, very loudly")
		return 0
	case "grandchild": // starts its own child in its group, and prints that child's pid
		cmd := exec.Command(os.Args[0], "helper", "sleep")
		if err := cmd.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println("grandchild", cmd.Process.Pid)
		select {}
	}
	return 2
}

// entries collects what the children print.
type entries struct {
	mu   sync.Mutex
	list []logs.Record
	ch   chan struct{}
}

func newEntries() *entries { return &entries{ch: make(chan struct{}, 1)} }

func (e *entries) emit(x logs.Record) {
	e.mu.Lock()
	e.list = append(e.list, x)
	e.mu.Unlock()
	select {
	case e.ch <- struct{}{}:
	default:
	}
}

func (e *entries) snapshot() []logs.Record {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]logs.Record(nil), e.list...)
}

// wait returns the first entry that match accepts. It fails the test after d.
func (e *entries) wait(t *testing.T, d time.Duration, what string, match func(logs.Record) bool) logs.Record {
	t.Helper()
	deadline := time.After(d)
	for {
		for _, x := range e.snapshot() {
			if match(x) {
				return x
			}
		}
		select {
		case <-e.ch:
		case <-deadline:
			var got []string
			for _, x := range e.snapshot() {
				got = append(got, fmt.Sprintf("%s/%s %v: %s", x.Component, x.Subcomponent, x.Level, x.Message))
			}
			t.Fatalf("no line %s; got:\n%v", what, got)
		}
	}
}

// runDir returns a run dir that is short enough for socket paths, wherever the temp folder is.
func runDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "rcui-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
