//go:build linux || darwin

package children

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

// TestMountEnds runs a real mount child (nfsmount on macOS, FUSE on Linux). When its stdin closes
// (the app is gone), it unmounts and exits. When it is killed instead, it leaves a broken mount
// point that ClearLeftovers clears. On macOS that check uses the recorded NFS port and never
// touches the folder, which would hang on a dead NFS mount. On Linux the folder returns ENOTCONN.
// The test is skipped where this user can't mount.
func TestMountEnds(t *testing.T) {
	if testing.Short() {
		t.Skip("mounts")
	}
	if runtime.GOOS == "linux" {
		if _, err := os.Stat("/dev/fuse"); err != nil {
			t.Skip("no /dev/fuse")
		}
	}
	a := newApp(t, Limits{LogLevel: "INFO"})
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), "a")
	base, err := os.MkdirTemp("", "rcui-mnt-") // not t.TempDir, whose cleanup would walk into the mount
	if err != nil {
		t.Fatal(err)
	}
	mp := filepath.Join(base, "mnt")
	if err := os.Mkdir(mp, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if ok, _ := Mounted(mp); ok {
			if err := Unmount(context.Background(), mp); err != nil {
				t.Errorf("cleanup: %v", err)
				return
			}
		}
		_ = os.Remove(mp)
		_ = os.Remove(base)
	})

	start := func(t *testing.T, name string) (*Unit, int) {
		t.Helper()
		args, port := []string{"mount", src, mp}, 0
		if runtime.GOOS == "darwin" {
			_, portStr, _ := strings.Cut(freeAddr(t), ":")
			port, _ = strconv.Atoi(portStr)
			args = []string{"nfsmount", src, mp, "--addr=127.0.0.1:" + portStr}
		}
		up := make(chan struct{}, 1)
		u, err := a.s.Start(Spec{
			Name: name, Kind: KindMount, MountPoint: mp, NFSPort: port, Rclone: args, ConfigPath: a.config,
			Component: logs.CompMounts, Subcomponent: name,
			Ready: func(ctx context.Context, _ *Process) error { // the mount table lists it
				for {
					if ok, err := Mounted(mp); err != nil || ok {
						return err
					}
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-time.After(100 * time.Millisecond):
					}
				}
			},
			OnUp:   func(*Unit) { up <- struct{}{} },
			OnDown: func(*Unit, Down) bool { return false },
		})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-up:
		case <-u.Done():
			var lines []string
			for _, e := range a.got.snapshot() {
				if e.Subcomponent == name {
					lines = append(lines, e.Message)
				}
			}
			t.Skipf("the mount child did not mount here: %v", lines)
		case <-time.After(30 * time.Second):
			t.Fatal("the mount was not ready in 30 s")
		}
		return u, port
	}

	t.Run("TheWatchdogUnmounts", func(t *testing.T) {
		u, _ := start(t, "watchdog")
		p := u.Process()
		_ = p.stdin.Close() // as when the app dies
		waitClosed(t, p.exited, 20*time.Second, "the child to exit")
		if ok, _ := Mounted(mp); ok {
			t.Fatal("still mounted after the child's watchdog ran")
		}
	})

	t.Run("AKilledMountIsClearedAtTheNextStart", func(t *testing.T) {
		u, port := start(t, "killed")
		p := u.Process()
		rec := Record{ID: u.ID(), Kind: KindMount, Name: "killed", PID: p.PID(), StartTime: p.startTime, MountPoint: mp, NFSPort: port}
		if err := kill(p.cmd.Process); err != nil { // like a crash, with no unmount
			t.Fatal(err)
		}
		waitClosed(t, u.Done(), 20*time.Second, "the down")
		if ok, _ := Mounted(mp); !ok {
			t.Skip("the killed mount went away by itself")
		}
		next := runDir(t)
		if err := writeRecords(next, []Record{rec}); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		began := time.Now()
		lo := ClearLeftovers(ctx, LeftoverOptions{RunDir: next})
		if len(lo.Cleared) != 1 || lo.Cleared[0] != resolvedMountPoint(mp) {
			t.Fatalf("cleared %v, want %s", lo.Cleared, resolvedMountPoint(mp))
		}
		if ok, _ := Mounted(mp); ok {
			t.Fatal("still mounted after ClearLeftovers")
		}
		t.Logf("cleared the broken mount in %v", time.Since(began))
	})
}
