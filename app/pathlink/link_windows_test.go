//go:build windows

package pathlink

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

// memPath keeps the user's PATH in memory instead of HKCU\Environment.
type memPath struct{ value string }

func (m *memPath) get() (string, error) { return m.value, nil }
func (m *memPath) set(v string) error   { m.value = v; return nil }

func newWindowsLinker(t *testing.T, withShim bool) (*Linker, *memPath) {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "Rclone UI", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if withShim {
		if err := os.WriteFile(filepath.Join(bin, "rclone.exe"), []byte("MZ"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	store := &memPath{value: `C:\Windows;C:\Tools`}
	l := &Linker{
		exe:      filepath.Join(root, "Rclone UI", "rcui.exe"),
		link:     bin,
		path:     func() []string { return filepath.SplitList(store.value) },
		userPath: store,
	}
	if !withShim {
		l.unsupported = i18n.M("no rclone.exe")
	}
	return l, store
}

func TestWindowsEnableDisable(t *testing.T) {
	l, store := newWindowsLinker(t, true)
	st, err := l.Enable()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Enabled || !pathHas(store.value, l.link) || st.Warning != "" {
		t.Fatalf("after Enable: %+v, PATH %q", st, store.value)
	}
	if st, err := l.Disable(); err != nil || st.Enabled || pathHas(store.value, l.link) {
		t.Fatalf("after Disable: %+v %v, PATH %q", st, err, store.value)
	}
	if store.value != `C:\Windows;C:\Tools` {
		t.Errorf("the rest of PATH changed: %q", store.value)
	}
}

func TestWindowsUserRclone(t *testing.T) {
	l, store := newWindowsLinker(t, true)
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "rclone.exe"), []byte("MZ"), 0o755); err != nil {
		t.Fatal(err)
	}
	store.value = other
	st, err := l.Enable()
	if err != nil {
		t.Fatal(err)
	}
	if st.UserRclone != filepath.Join(other, "rclone.exe") || st.Warning == "" {
		t.Fatalf("status: %+v", st)
	}
}

func TestWindowsUnsupported(t *testing.T) {
	l, store := newWindowsLinker(t, false)
	if st := l.Status(); st.Supported {
		t.Fatalf("status: %+v", st)
	}
	if _, err := l.Enable(); !errors.Is(err, ErrUnsupported) || pathHas(store.value, l.link) {
		t.Fatalf("Enable: %v, PATH %q", err, store.value)
	}
}

func TestWindowsCommand(t *testing.T) {
	l, _ := newWindowsLinker(t, true)
	shim := `& "` + filepath.Join(l.link, "rclone.exe") + `"`
	if got := l.Status().Command; got != shim {
		t.Errorf("no link: %q", got)
	}
	if _, err := l.Enable(); err != nil {
		t.Fatal(err)
	}
	if got := l.Status().Command; got != "rclone" {
		t.Errorf("on PATH: %q", got)
	}
	alone, _ := newWindowsLinker(t, false)
	if got := alone.Status().Command; got != `& "`+alone.exe+`"` {
		t.Errorf("an rcui.exe without bin\\rclone.exe: %q", got)
	}
}
