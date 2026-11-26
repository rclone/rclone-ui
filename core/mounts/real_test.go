package mounts

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/operations"
)

func TestRealMount(t *testing.T) {
	if os.Getenv("RCUI_TEST_MOUNTS") != "1" {
		t.Skip("set RCUI_TEST_MOUNTS=1 to mount for real")
	}
	if sup := CheckSupport(); !sup.Supported {
		t.Fatalf("this machine cannot mount: %s", sup.Reason)
	}
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.mounted = mounted
		o.unmount = func(ctx context.Context, mp string) error {
			began := time.Now()
			err := children.Unmount(ctx, mp)
			t.Logf("unmount took %v: %v", time.Since(began), err)
			return err
		}
		o.command = operations.MountCommand
		o.support = CheckSupport
	}})
	src, _ := f.place("real")
	base, err := os.MkdirTemp("", "rcui-mnt-") // not t.TempDir, whose cleanup would walk into the mount
	if err != nil {
		t.Fatal(err)
	}
	mp := filepath.Join(base, "mnt")
	t.Cleanup(func() {
		if ok, _ := mounted(mp); ok {
			if err := children.Unmount(context.Background(), mp); err != nil {
				t.Errorf("cleanup: %v", err)
				return
			}
		}
		_ = os.RemoveAll(base)
	})

	began := time.Now()
	m, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: mp,
		Options: groupsOf("vfs", `{"vfs_cache_mode":"writes"}`)})
	if err != nil {
		t.Fatal(err)
	}
	answered := time.Since(began)
	got := f.ev.wait(t, m.ID, children.StatusRunning, children.StatusFailed)
	if got.State != string(children.StatusRunning) {
		t.Fatalf("the mount failed: %s\n%s", got.Error, f.lines.dump())
	}
	t.Logf("start answered in %v, running after %v", answered, time.Since(began))
	if line := f.lines.cacheRefused(); line != "" {
		t.Fatalf("the mount's VFS cache was refused: %s", line)
	}

	b, err := os.ReadFile(filepath.Join(mp, "a.txt"))
	if err != nil || string(b) != "a" {
		t.Fatalf("read through the mount: %q, %v", b, err)
	}
	if err := os.WriteFile(filepath.Join(mp, "b.txt"), []byte("b"), 0o600); err != nil {
		t.Fatalf("write through the mount: %v", err)
	}
	testutil.Eventually(t, 30*time.Second, "b.txt uploaded to the source", func() bool { return exists(filepath.Join(src, "b.txt")) })
	// rclone marks b.txt clean in its cache a moment after the file is at the source, and keeps
	// it in the upload queue until then. A crash in between leaves b.txt dirty, so the mount
	// that starts again queues it once more, and the stop at the end rightly lists it as waiting.
	// So the crash below waits for the queue to be empty.
	rc := f.s.RC(m.ID)
	if rc == nil {
		t.Fatal("the mount is not running any more")
	}
	qctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	testutil.Eventually(t, 30*time.Second, "b.txt to leave the upload queue", func() bool {
		queue, err := rc.VFSQueue(qctx)
		return err == nil && len(queue) == 0
	})

	p, err := os.FindProcess(f.s.List()[0].PID)
	if err != nil {
		t.Fatal(err)
	}
	crashed := time.Now()
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	f.ev.wait(t, m.ID, children.StatusRestarting)
	t.Logf("restarting %v after the crash", time.Since(crashed))
	if got := f.ev.waitN(t, m.ID, 2, children.StatusRunning); got.State != string(children.StatusRunning) {
		t.Fatalf("not running again: %+v", got)
	}
	t.Logf("running again %v after the crash", time.Since(crashed))
	if b, err := os.ReadFile(filepath.Join(mp, "b.txt")); err != nil || string(b) != "b" {
		t.Fatalf("read through the mount after the crash: %q, %v", b, err)
	}

	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if ok, err := mounted(mp); err != nil || ok {
		t.Fatalf("still mounted after the stop (%v)", err)
	}
	if rows := f.stoppedRows(); len(rows) != 0 {
		t.Fatalf("stopped mounts %+v\n%s", rows, f.lines.dump())
	}
}

func TestRealDriveMount(t *testing.T) {
	if os.Getenv("RCUI_TEST_MOUNTS") != "1" || runtime.GOOS != "windows" {
		t.Skip("set RCUI_TEST_MOUNTS=1 on Windows to mount a drive for real")
	}
	if sup := CheckSupport(); !sup.Supported {
		t.Fatalf("this machine cannot mount: %s", sup.Reason)
	}
	f := newFixture(t, fixtureOpts{logLevel: "ERROR", tweak: func(o *Options) {
		o.mounted = mounted
		o.command = operations.MountCommand
		o.support = CheckSupport
	}})
	src, _ := f.place("drive")
	m, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: "*"})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.MountPoint) != 2 || m.MountPoint[1] != ':' {
		t.Fatalf("answered %+v, want a drive", m)
	}
	if got := f.ev.wait(t, m.ID, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) || got.MountPoint != m.MountPoint {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	if b, err := os.ReadFile(m.MountPoint + `\a.txt`); err != nil || string(b) != "a" {
		t.Fatalf("read through the drive: %q, %v", b, err)
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
}
