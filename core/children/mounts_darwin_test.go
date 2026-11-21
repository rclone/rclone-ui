package children

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMountedReadsTheTableOnly(t *testing.T) {
	if ok, err := Mounted("/"); err != nil || !ok {
		t.Fatalf("Mounted(/) = %v, %v", ok, err)
	}
	if ok, err := Mounted(t.TempDir()); err != nil || ok {
		t.Fatalf("Mounted(a plain folder) = %v, %v", ok, err)
	}
}

// A mount point typed in another case than its folder has on disk is found in the mount table,
// which spells it as the disk does. A path that only looks alike, in another folder, is not.
func TestListedIgnoresCaseWhereTheVolumeDoes(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "rclone"), 0o700); err != nil {
		t.Fatal(err)
	}
	onDisk := filepath.Join(dir, "rclone", "box")
	typed := filepath.Join(dir, "Rclone", "box")
	points := map[string]bool{onDisk: true}

	if got, ok := listed(points, onDisk); !ok || got != onDisk {
		t.Errorf("as the disk spells it: %q, %v", got, ok)
	}
	if !ignoresCase(dir) {
		// On a volume that tells case apart, Rclone is another folder, which doesn't exist.
		if _, ok := listed(points, typed); ok {
			t.Error("another folder's mount counts on a volume that tells case apart")
		}
		return
	}
	if got, ok := listed(points, typed); !ok || got != onDisk {
		t.Errorf("in another case: %q, %v, want %q", got, ok, onDisk)
	}
	// The mount point's own name in another case is the same name too.
	if got, ok := listed(points, filepath.Join(dir, "rclone", "BOX")); !ok || got != onDisk {
		t.Errorf("its own name in another case: %q, %v", got, ok)
	}
	// The same names under another folder are another place.
	other := filepath.Join(dir, "other")
	if err := os.MkdirAll(filepath.Join(other, "rclone"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, ok := listed(points, filepath.Join(other, "Rclone", "box")); ok {
		t.Error("a mount under another folder counts")
	}
	if _, ok := listed(points, filepath.Join(dir, "rclone", "boxes")); ok {
		t.Error("another name counts")
	}
}
