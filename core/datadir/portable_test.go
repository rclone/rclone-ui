package datadir

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

func TestPortable(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "rcui.exe")
	if got, ok := portable("windows", exe, os.Stat); ok {
		t.Fatalf("without a data folder: portable at %q", got)
	}

	testutil.Must(t, os.WriteFile(filepath.Join(root, PortableDir), nil, 0o600))
	if _, ok := portable("windows", exe, os.Stat); ok {
		t.Fatal("a file named data made the copy portable")
	}
	testutil.Must(t, os.Remove(filepath.Join(root, PortableDir)))

	testutil.Must(t, os.Mkdir(filepath.Join(root, PortableDir), 0o700))
	if got, ok := portable("windows", exe, os.Stat); !ok || got != root {
		t.Fatalf("with a data folder: %q, %v; want %q", got, ok, root)
	}
	for _, goos := range []string{"darwin", "linux"} {
		if _, ok := portable(goos, exe, os.Stat); ok {
			t.Errorf("%s has a portable copy", goos)
		}
	}
	if _, ok := portable("windows", "", os.Stat); ok {
		t.Error("an unknown executable is portable")
	}
}
