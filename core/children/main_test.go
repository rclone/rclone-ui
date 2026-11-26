package children

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
	if len(os.Args) > 1 && os.Args[1] == "helper" {
		os.Exit(helper(os.Args[2:]))
	}
	if _, ok := os.LookupEnv(childenv.Env); ok {
		childenv.Adopt(OwnMount)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	testutil.Main(m, nil)
}

func helper(args []string) int {
	if len(args) == 0 {
		return 2
	}
	switch args[0] {
	case "exit":
		code, _ := strconv.Atoi(args[1])
		return code
	case "up-then-exit":
		ms, _ := strconv.Atoi(args[1])
		time.Sleep(time.Duration(ms) * time.Millisecond)
		return 1
	case "fail":
		fmt.Fprintln(os.Stderr, args[1])
		return 1
	case "sleep":
		select {}
	case "err-then-sleep":
		fmt.Fprintln(os.Stderr, args[1])
		select {}
	case "env":
		v, ok := os.LookupEnv(args[1])
		fmt.Println(args[1], v, ok)
		return 0
	case "ignore-term":
		signal.Ignore(syscall.SIGTERM)
		fmt.Println("ready")
		select {}
	case "print":
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGTERM)
		fmt.Println("hello from stdout")
		fmt.Fprintln(os.Stderr, "hello from stderr")
		<-c
		fmt.Fprintln(os.Stderr, "ERROR shutting down, very loudly")
		return 0
	case "grandchild":
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

func runDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "rcui-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
