package datadir

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

func TestLockExcludesASecondHolderUntilReleased(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	release, err := Lock(context.Background(), dir, 0)
	testutil.Must(t, err)

	start := time.Now()
	if _, err := Lock(context.Background(), dir, 300*time.Millisecond); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: %v, want ErrLocked", err)
	}
	if waited := time.Since(start); waited < 300*time.Millisecond {
		t.Fatalf("gave up after %v, before its wait", waited)
	}

	// When the lock is released while the second caller is still trying, the second caller gets it.
	go func() {
		time.Sleep(100 * time.Millisecond)
		release()
	}()
	release2, err := Lock(context.Background(), dir, 5*time.Second)
	testutil.Must(t, err)
	release2()

	info, err := os.Stat(dir)
	testutil.Must(t, err)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("data dir mode %v", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(dir, LockFile)); err != nil {
		t.Fatalf("lock file: %v", err)
	}
}

func TestLockGivesUpWithItsContext(t *testing.T) {
	dir := t.TempDir()
	release, err := Lock(context.Background(), dir, 0)
	testutil.Must(t, err)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if _, err := Lock(ctx, dir, time.Minute); !errors.Is(err, context.Canceled) {
		t.Fatalf("Lock = %v, want the context's cancellation", err)
	}
}

// TestRunDir checks that the run folder is run/ inside the data dir, however long its path,
// because what it keeps must survive a reboot.
func TestRunDir(t *testing.T) {
	for _, data := range []string{t.TempDir(), filepath.Join(t.TempDir(), strings.Repeat("a", 60), strings.Repeat("b", 40))} {
		a, err := RunDir(data, "")
		testutil.Must(t, err)
		b, err := RunDir(data, "")
		testutil.Must(t, err)
		if want := filepath.Join(data, RunDirName); a != want || b != a {
			t.Fatalf("run dirs %s %s, want %s", a, b, want)
		}
		info, err := os.Stat(a)
		testutil.Must(t, err)
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
			t.Fatalf("run dir mode %v", info.Mode().Perm())
		}
	}

	override := filepath.Join(t.TempDir(), "run")
	f, err := RunDir(t.TempDir(), override)
	testutil.Must(t, err)
	info, err := os.Stat(f)
	testutil.Must(t, err)
	if f != override || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o700) {
		t.Fatalf("override %s → %s %v", override, f, info.Mode())
	}
}

// TestSocketDir checks that each data dir gets one short socket folder, however long the data
// dir's path. The folder is in $XDG_RUNTIME_DIR when it is set, or else in the temp folder. An
// override is used as given.
func TestSocketDir(t *testing.T) {
	long := filepath.Join(t.TempDir(), strings.Repeat("a", 60), strings.Repeat("b", 40))
	other := filepath.Join(t.TempDir(), strings.Repeat("c", 60), strings.Repeat("d", 40))
	t.Setenv("XDG_RUNTIME_DIR", "")
	c, err := SocketDir(long, "")
	testutil.Must(t, err)
	again, err := SocketDir(long, "")
	testutil.Must(t, err)
	d, err := SocketDir(other, "")
	testutil.Must(t, err)
	t.Cleanup(func() { _ = os.Remove(c); _ = os.Remove(d) })
	if c == d || c != again || !strings.HasPrefix(filepath.Base(c), "rcui-") || len(filepath.Base(c)) > len("rcui-4294967295-12345678") {
		t.Fatalf("socket dirs %s %s %s: want one short rcui- folder per data dir", c, again, d)
	}
	if len(c)+1+MaxSocketName > maxSocketPath {
		t.Fatalf("socket dir %s leaves no room for a socket", c)
	}
	info, err := os.Stat(c)
	testutil.Must(t, err)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("socket dir mode %v", info.Mode().Perm())
	}

	xdg := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", xdg)
	e, err := SocketDir(long, "")
	testutil.Must(t, err)
	if filepath.Dir(e) != xdg || !strings.HasPrefix(filepath.Base(e), "rcui-") {
		t.Fatalf("with XDG_RUNTIME_DIR: %s", e)
	}

	override := filepath.Join(t.TempDir(), "s")
	if f, err := SocketDir(long, override); err != nil || f != override {
		t.Fatalf("override %s → %s %v", override, f, err)
	}
}

func TestDefault(t *testing.T) {
	d, err := Default()
	testutil.Must(t, err)
	if filepath.Base(d) != Identifier || !filepath.IsAbs(d) {
		t.Fatalf("Default() = %s", d)
	}
	home, err := os.UserHomeDir()
	testutil.Must(t, err)
	switch runtime.GOOS {
	case "darwin":
		if want := filepath.Join(home, "Library", "Application Support", Identifier); d != want {
			t.Fatalf("Default() = %s, want %s", d, want)
		}
	case "linux":
		xdg := t.TempDir()
		t.Setenv("XDG_DATA_HOME", xdg)
		if d, _ := Default(); d != filepath.Join(xdg, Identifier) {
			t.Fatalf("with XDG_DATA_HOME: %s", d)
		}
		t.Setenv("XDG_DATA_HOME", "relative/ignored")
		if d, _ := Default(); d != filepath.Join(home, ".local", "share", Identifier) {
			t.Fatalf("with a relative XDG_DATA_HOME: %s", d)
		}
	}
}
