package childenv

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteKeyFile(t *testing.T) {
	dir := t.TempDir()
	want := []byte("obscured-key\x00\xff")
	path, err := WriteKeyFile(dir, want)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("written to %s, not in %s", path, dir)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, want) {
		t.Errorf("contents %q", got)
	}
	if _, err := WriteKeyFile(filepath.Join(dir, "missing"), want); err == nil {
		t.Error("a missing folder took a key file")
	}
}
