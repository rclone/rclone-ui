//go:build unix

package children

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestSocketModes checks that a rclone child's rc socket is 0600, whatever umask it inherits.
func TestSocketModes(t *testing.T) {
	old := syscall.Umask(0o002) // would make the socket group-writable, enough to connect on Linux
	defer syscall.Umask(old)
	a := newApp(t, Limits{LogLevel: "INFO"})
	u, _ := a.serve(t, "modes", t.TempDir(), nil)
	for _, p := range []string{rcSock(a.run, u.ID())} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v, want a 0600 socket", filepath.Base(p), fi.Mode())
		}
	}
}
