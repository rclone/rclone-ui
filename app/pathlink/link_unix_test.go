//go:build !windows

package pathlink

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/rclone"
)

// fixture is a Linker set up in temporary folders, with the app's executable, the link's folder
// (on PATH or not) and the pointer in the data folder.
type fixture struct {
	l       *Linker
	root    string
	pathDir []string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	exe := filepath.Join(root, "app", "rcui")
	writeExe(t, exe)
	f := &fixture{root: root}
	f.l = &Linker{
		exe:     exe,
		link:    filepath.Join(root, "bin", "rclone"),
		pointer: filepath.Join(root, "data", "bin", "rclone"),
		path:    func() []string { return f.pathDir },
	}
	return f
}

func writeExe(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func readlink(t *testing.T, name string) string {
	t.Helper()
	target, err := os.Readlink(name)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func TestEnableDisable(t *testing.T) {
	f := newFixture(t)
	if st := f.l.Status(); !st.Supported || st.Enabled {
		t.Fatalf("before: %+v", st)
	}
	st, err := f.l.Enable()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Enabled || readlink(t, f.l.link) != f.l.pointer || readlink(t, f.l.pointer) != f.l.exe {
		t.Fatalf("after Enable: %+v", st)
	}
	if !strings.Contains(st.Warning, "isn't on your PATH") {
		t.Errorf("a link outside PATH: warning %q", st.Warning)
	}
	f.pathDir = []string{filepath.Dir(f.l.link)}
	if st := f.l.Status(); st.Warning != "" {
		t.Errorf("a link on PATH: warning %q", st.Warning)
	}
	// Enabling again changes nothing.
	if st, err := f.l.Enable(); err != nil || !st.Enabled {
		t.Fatalf("a second Enable: %+v %v", st, err)
	}

	st, err = f.l.Disable()
	if err != nil {
		t.Fatal(err)
	}
	if st.Enabled {
		t.Fatalf("after Disable: %+v", st)
	}
	for _, name := range []string{f.l.link, f.l.pointer} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still there: %v", name, err)
		}
	}
	if _, err := os.Stat(f.l.exe); err != nil {
		t.Errorf("the app itself: %v", err)
	}
}

func TestForeignRclone(t *testing.T) {
	f := newFixture(t)
	writeExe(t, f.l.link)
	_, err := f.l.Enable()
	if !errors.Is(err, ErrForeign) {
		t.Fatalf("Enable over a user's rclone: %v", err)
	}
	if info, err := os.Lstat(f.l.link); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the user's rclone was replaced: %v %v", info, err)
	}
	if _, err := f.l.Disable(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(f.l.link); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("Disable removed the user's rclone: %v %v", info, err)
	}
}

func TestDanglingLink(t *testing.T) {
	f := newFixture(t)
	if err := os.MkdirAll(filepath.Dir(f.l.link), 0o755); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(f.root, "gone")
	if err := os.Symlink(gone, f.l.link); err != nil {
		t.Fatal(err)
	}
	_, err := f.l.Enable()
	if !errors.Is(err, ErrForeign) || !strings.Contains(err.Error(), "(a link to "+gone+", which no longer exists)") {
		t.Fatalf("Enable over a dead link elsewhere: %v", err)
	}
	if _, err := f.l.Disable(); err != nil {
		t.Fatal(err)
	}
	if readlink(t, f.l.link) != gone {
		t.Fatal("Disable removed the dead link")
	}

	if err := os.Remove(f.l.link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(f.l.pointer, f.l.link); err != nil {
		t.Fatal(err)
	}
	if st, err := f.l.Enable(); err != nil || !st.Enabled || readlink(t, f.l.pointer) != f.l.exe {
		t.Fatalf("Enable over a dead link to the pointer: %+v %v", st, err)
	}
}

func TestUserRcloneOnPath(t *testing.T) {
	f := newFixture(t)
	other := filepath.Join(f.root, "usr", "bin")
	writeExe(t, filepath.Join(other, "rclone"))
	if _, err := f.l.Enable(); err != nil {
		t.Fatal(err)
	}
	f.pathDir = []string{other, filepath.Dir(f.l.link)}
	if st := f.l.Status(); st.UserRclone != filepath.Join(other, "rclone") || !strings.Contains(st.Warning, "comes first") {
		t.Errorf("a user's rclone first: %+v", st)
	}
	f.pathDir = []string{filepath.Dir(f.l.link), other}
	if st := f.l.Status(); !strings.Contains(st.Warning, "now runs Rclone UI's rclone") {
		t.Errorf("a user's rclone after: %+v", st)
	}
}

func TestRefresh(t *testing.T) {
	f := newFixture(t)
	if err := f.l.Refresh(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(f.l.pointer); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Refresh without a link made the pointer: %v", err)
	}

	moved := filepath.Join(f.root, "old place", "rcui")
	writeExe(t, moved)
	for name, target := range map[string]string{f.l.pointer: moved, f.l.link: f.l.pointer} {
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, name); err != nil {
			t.Fatal(err)
		}
	}
	if st := f.l.Status(); st.Enabled {
		t.Fatalf("the moved app's link counts as enabled before Refresh: %+v", st)
	}
	if err := f.l.Refresh(); err != nil {
		t.Fatal(err)
	}
	if readlink(t, f.l.pointer) != f.l.exe || !f.l.Status().Enabled {
		t.Fatalf("after Refresh: pointer → %s", readlink(t, f.l.pointer))
	}
}

func TestAdminPrompt(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes everywhere")
	}
	f := newFixture(t)
	dir := filepath.Dir(f.l.link)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	var prompts []string
	f.l.asAdmin = func(shellCmd, prompt string) error {
		prompts = append(prompts, prompt)
		// Act as the administrator's shell, with the folder writable while it runs.
		if err := os.Chmod(dir, 0o755); err != nil {
			return err
		}
		defer func() { _ = os.Chmod(dir, 0o555) }()
		out, err := exec.Command("/bin/sh", "-c", shellCmd).CombinedOutput()
		if err != nil {
			return errors.New(string(out))
		}
		return nil
	}
	if st := f.l.Status(); !st.NeedsAdmin {
		t.Fatalf("status: %+v", st)
	}
	if st, err := f.l.Enable(); err != nil || !st.Enabled {
		t.Fatalf("Enable: %+v %v", st, err)
	}
	if st, err := f.l.Disable(); err != nil || st.Enabled {
		t.Fatalf("Disable: %+v %v", st, err)
	}
	if len(prompts) != 2 {
		t.Fatalf("prompts: %q", prompts)
	}
}

func TestCommand(t *testing.T) {
	f := newFixture(t)
	if got := f.l.Status().Command; got != f.l.exe {
		t.Errorf("no link: %q", got)
	}
	f.pathDir = []string{filepath.Dir(f.l.exe)}
	if got := f.l.Status().Command; got != "rcui" {
		t.Errorf("rcui on PATH: %q", got)
	}
	if _, err := f.l.Enable(); err != nil {
		t.Fatal(err)
	}
	if got := f.l.Status().Command; got != "rcui" {
		t.Errorf("a link off PATH: %q", got)
	}
	f.pathDir = []string{filepath.Dir(f.l.link)}
	if got := f.l.Status().Command; got != "rclone" {
		t.Errorf("a link on PATH: %q", got)
	}
	other := filepath.Join(f.root, "usr", "bin")
	writeExe(t, filepath.Join(other, "rclone"))
	f.pathDir = []string{other, filepath.Dir(f.l.link)}
	if got := f.l.Status().Command; got != f.l.exe {
		t.Errorf("a user's rclone first: %q", got)
	}

	if got := shCommand("/Applications/Rclone UI.app/Contents/MacOS/rcui", nil); got != `'/Applications/Rclone UI.app/Contents/MacOS/rcui'` {
		t.Errorf("a path with a space: %q", got)
	}
}

// TestRefusalsReachThePageTranslated: Enable's refusals keep their kind for errors.Is, and the
// page gets their text in the app's language (the test language here).
func TestRefusalsReachThePageTranslated(t *testing.T) {
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	link := filepath.Join(t.TempDir(), "rclone")
	if err := os.WriteFile(link, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		err  error
		kind error
		want string
	}{
		{foreign(link), ErrForeign, "[Áñ rçlóñé thát ísñ't Rçlóñé ÚÍ's ís álréádý át " + link},
		{unsupported(i18n.M("Rclone UI doesn't add rclone to PATH on this system.")), ErrUnsupported, "[Rçlóñé ÚÍ dóésñ't ádd rçlóñé tó PÁTH óñ thís sýstém.]"},
	} {
		if !errors.Is(c.err, c.kind) {
			t.Errorf("%v is not %v", c.err, c.kind)
		}
		if got := rclone.ErrorOf(c.err).Localized().Message; !strings.HasPrefix(got, c.want) {
			t.Errorf("the page gets %q, want it to start with %q", got, c.want)
		}
	}
}
