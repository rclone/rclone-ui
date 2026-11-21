package autostart

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPortableIdentifier(t *testing.T) {
	root := t.TempDir()
	a := portableIdentifier(filepath.Join(root, "Rclone UI"))
	b := portableIdentifier(filepath.Join(root, "Other copy"))
	if a == b || a == Identifier || !strings.HasPrefix(a, Identifier+".portable-") {
		t.Fatalf("names %q and %q", a, b)
	}
	if again := portableIdentifier(filepath.Join(root, "RCLONE UI")); again != a {
		t.Errorf("the same folder in capitals: %q, want %q", again, a)
	}
	for _, r := range a {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", r) {
			t.Fatalf("%q has %q, which Wails refuses", a, r)
		}
	}
}
