package testutil

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/config"
)

func Must(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Eventually waits up to d for cond to become true. If it never does, Eventually fails t with a
// message that names what it waited for.
func Eventually(t testing.TB, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", d, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

var homeVars = []string{"HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}

// Home points every per-user folder of this process, and of the children it starts, at dir, and
// unsets RCLONE_CONFIG. rclone chose its default config file during its init, based on the real
// home, so Home also points that default at dir/rclone/rclone.conf.
func Home(dir string) {
	_ = os.Unsetenv("RCLONE_CONFIG")
	for _, k := range homeVars {
		_ = os.Setenv(k, dir)
	}
	_ = config.SetConfigPath(filepath.Join(dir, "rclone", "rclone.conf"))
}

// Main is a TestMain. It runs the tests with their own home folder (Home on a new temp dir, with
// its symlinks resolved). When setup is not nil, it runs first on that dir (for rclone's init, or
// a config file). Main removes the dir and then exits with the tests' exit code.
func Main(m *testing.M, setup func(dir string) error) {
	os.Exit(run(m, setup))
}

func run(m *testing.M, setup func(dir string) error) int {
	dir, err := os.MkdirTemp("", "rcui-test-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() { _ = os.RemoveAll(dir) }()
	// macOS's temp dir is behind a symlink, and tests compare the paths they get back with this
	// one.
	if dir, err = filepath.EvalSymlinks(dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	Home(dir)
	if setup != nil {
		if err := setup(dir); err != nil {
			fmt.Fprintln(os.Stderr, "test setup:", err)
			return 1
		}
	}
	return m.Run()
}
