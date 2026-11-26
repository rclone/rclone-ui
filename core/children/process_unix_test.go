//go:build unix

package children

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
)

func TestStopKillsWhatIgnoresSIGTERM(t *testing.T) {
	got := newEntries()
	s := newSupervisor(t, Options{Emit: got.emit})
	s.grace = 200 * time.Millisecond
	u, err := s.Start(helperSpec("stubborn", "ignore-term"))
	if err != nil {
		t.Fatal(err)
	}
	got.wait(t, 10*time.Second, "ready", func(e logs.Record) bool { return e.Message == "ready" })
	p := u.Process()
	began := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := u.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took < s.grace {
		t.Fatalf("stopped in %v, before its grace: SIGTERM was not ignored?", took)
	}
	if !p.Killed() {
		t.Fatal("Killed() is false after the stop killed it")
	}
}

func TestStopEndsTheWholeGroup(t *testing.T) {
	got := newEntries()
	s := newSupervisor(t, Options{Emit: got.emit})
	u, err := s.Start(helperSpec("parent", "grandchild"))
	if err != nil {
		t.Fatal(err)
	}
	line := got.wait(t, 10*time.Second, "the grandchild's pid", func(e logs.Record) bool { return strings.HasPrefix(e.Message, "grandchild ") })
	pid, err := strconv.Atoi(strings.TrimPrefix(line.Message, "grandchild "))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := u.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	waitNoProcess(t, pid)
}

func TestExitEndsTheWholeGroup(t *testing.T) {
	got := newEntries()
	s := newSupervisor(t, Options{Emit: got.emit})
	d := newDowns(1)
	spec := helperSpec("parent", "grandchild")
	spec.OnDown = d.onDown
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	line := got.wait(t, 10*time.Second, "the grandchild's pid", func(e logs.Record) bool { return strings.HasPrefix(e.Message, "grandchild ") })
	pid, _ := strconv.Atoi(strings.TrimPrefix(line.Message, "grandchild "))
	if err := syscall.Kill(u.Process().PID(), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, u.Done(), 10*time.Second, "the down")
	waitNoProcess(t, pid)
}

func waitNoProcess(t *testing.T, pid int) {
	t.Helper()
	testutil.Eventually(t, 5*time.Second, fmt.Sprintf("process %d to end", pid), func() bool {
		return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
	})
}

func startLeftover(t *testing.T) (*exec.Cmd, int64) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "helper", "sleep")
	cmd.SysProcAttr = sysProcAttr()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-exited
	})
	var st int64
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		if st, err = processStartTime(cmd.Process.Pid); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cmd, st
}

func TestClearLeftovers(t *testing.T) {
	dir := runDir(t)
	ours, oursStart := startLeftover(t)
	other, otherStart := startLeftover(t)
	recs := []Record{
		{ID: "11111111", Kind: KindServe, Name: "http:127.0.0.1:8080", PID: ours.Process.Pid, StartTime: oursStart, Args: []string{"serve", "http", "a:"}, Addr: "127.0.0.1:8080"},
		{ID: "22222222", Kind: KindMount, Name: "/mnt/x", PID: other.Process.Pid, StartTime: otherStart + 1, Args: []string{"mount", "b:", "/mnt/x"}, MountPoint: "/nonexistent/rcc-test/x", NFSPort: 1},
		{ID: "44444444", Kind: KindServe, Name: "stopped serve"},
	}
	if err := writeRecords(dir, recs); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"c-11111111.sock", "key-12345", "keep.txt"} {
		if err := os.WriteFile(dir+"/"+name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	lo := ClearLeftovers(context.Background(), LeftoverOptions{RunDir: dir, unmount: noUnmount(t)})
	if len(lo.Killed) != 1 || lo.Killed[0].ID != "11111111" {
		t.Fatalf("killed %+v, want only the child whose start time matched", lo.Killed)
	}
	waitNoProcess(t, -ours.Process.Pid)
	if err := syscall.Kill(other.Process.Pid, 0); err != nil {
		t.Fatalf("killed a process whose start time did not match: %v", err)
	}
	if len(lo.Cleared) != 0 {
		t.Fatalf("cleared %v: nothing was mounted", lo.Cleared)
	}
	var ids []string
	for _, r := range lo.Restore {
		ids = append(ids, r.ID)
		if r.PID != 0 || r.StartTime != 0 || !r.Restore {
			t.Errorf("restore record %+v", r)
		}
	}
	if strings.Join(ids, ",") != "11111111,22222222" {
		t.Fatalf("restore %v, want the mount and serve that were running", ids)
	}
	begun(t, Options{RunDir: dir}, lo.Restore...)
	onDisk, err := readRecords(dir)
	if err != nil || len(onDisk) != 2 {
		t.Fatalf("children.json after = %+v (%v), want the two to restore", onDisk, err)
	}
	for _, name := range []string{"c-11111111.sock", "key-12345"} {
		if _, err := os.Stat(dir + "/" + name); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s was not swept", name)
		}
	}
	if _, err := os.Stat(dir + "/keep.txt"); err != nil {
		t.Errorf("the sweep removed another file: %v", err)
	}
}

func TestAQuitThatRunsOutOfTimeBringsNothingBack(t *testing.T) {
	got := newEntries()
	s := begun(t, Options{RunDir: runDir(t), Exe: os.Args[0], Emit: got.emit})
	s.grace = time.Minute
	spec := helperSpec("stubborn", "ignore-term")
	spec.Kind = KindServe
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	got.wait(t, 10*time.Second, "ready", func(e logs.Record) bool { return e.Message == "ready" })

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := s.StopAll(ctx, nil); err == nil {
		t.Fatal("StopAll returned nil while the child was still stopping")
	}
	recs, err := readRecords(s.o.RunDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || recs[0].PID == 0 || !recs[0].Stopping || recs[0].Restore {
		t.Fatalf("children.json after the quit ran out of time: %+v", recs)
	}

	lo := ClearLeftovers(context.Background(), LeftoverOptions{RunDir: s.o.RunDir, unmount: noUnmount(t)})
	if len(lo.Killed) != 1 || len(lo.Restore) != 0 {
		t.Fatalf("leftovers %+v: want the serve killed, and nothing to start again", lo)
	}
	waitClosed(t, u.Done(), 10*time.Second, "the unit")
}

func TestClearLeftoversRestoresNothingStillRunning(t *testing.T) {
	dir := runDir(t)
	alive, start := startLeftover(t)
	recs := []Record{
		{ID: "11111111", Kind: KindServe, Name: "http:127.0.0.1:8080", PID: alive.Process.Pid, StartTime: start, Args: []string{"serve", "http", "a:"}},
		{ID: "11111111", Kind: KindServe, Name: "http:127.0.0.1:8080", Args: []string{"serve", "http", "a:"}, Restore: true},
	}
	if err := writeRecords(dir, recs); err != nil {
		t.Fatal(err)
	}
	refused := func(int) error { return syscall.EPERM }
	lo := ClearLeftovers(context.Background(), LeftoverOptions{RunDir: dir, unmount: noUnmount(t), kill: refused})
	if len(lo.Killed) != 0 || len(lo.Restore) != 0 {
		t.Fatalf("leftovers %+v: want nothing killed or started again", lo)
	}
	if err := syscall.Kill(alive.Process.Pid, 0); err != nil {
		t.Fatalf("the leftover is gone: %v", err)
	}
}

func TestClearLeftoversSurvivesABadFile(t *testing.T) {
	dir := runDir(t)
	if err := os.WriteFile(dir+"/"+recordsFile, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	lo := ClearLeftovers(context.Background(), LeftoverOptions{RunDir: dir, unmount: noUnmount(t)})
	if len(lo.Restore) != 0 {
		t.Fatalf("leftovers %+v", lo)
	}
	begun(t, Options{RunDir: dir}, lo.Restore...)
	if recs, err := readRecords(dir); err != nil || len(recs) != 0 {
		t.Fatalf("children.json after = %+v, %v", recs, err)
	}
}

func TestProcessStartTime(t *testing.T) {
	a, err := processStartTime(os.Getpid())
	if err != nil || a == 0 {
		t.Fatalf("own start time %d, %v", a, err)
	}
	if b, _ := processStartTime(os.Getpid()); b != a {
		t.Fatalf("start time changed: %d then %d", a, b)
	}
	cmd := exec.Command(os.Args[0], "helper", "exit", "0")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if _, err := processStartTime(cmd.Process.Pid); !errors.Is(err, errNoProcess) {
		t.Fatalf("a reaped process: %v, want errNoProcess", err)
	}
}
