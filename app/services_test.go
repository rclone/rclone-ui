package app

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWritePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no mode bits")
	}
	dir := t.TempDir()
	fresh := filepath.Join(dir, "templates.json")
	replaced := filepath.Join(dir, "rclone.conf")
	if err := os.WriteFile(replaced, []byte("an older and longer file"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{fresh, replaced} {
		if err := writePrivate(path, "{}"); err != nil {
			t.Fatal(err)
		}
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v", filepath.Base(path), st.Mode().Perm())
		}
		if b, _ := os.ReadFile(path); string(b) != "{}" {
			t.Errorf("%s: %q", filepath.Base(path), b)
		}
	}
}

func TestBrowsable(t *testing.T) {
	for _, ok := range []string{
		"https://rclone.org/drive/#making-your-own-client-id",
		"http://127.0.0.1:53682/auth?state=x",
		"HTTPS://github.com/rclone/rclone-ui",
		"mailto:support@rcloneui.com",
	} {
		if err := browsable(ok); err != nil {
			t.Errorf("browsable(%q): %v", ok, err)
		}
	}
	for _, bad := range []string{
		"",
		"/Applications/Calculator.app",
		"-aCalculator",
		"-https://example.com",
		`C:\path\evil.exe`,
		"file:///etc/passwd",
		"javascript:alert(1)",
		"smb://host/share",
		"https:///no-host",
		"https://example.com/\nx",
	} {
		if err := browsable(bad); err == nil {
			t.Errorf("browsable(%q) accepted it", bad)
		}
	}
}

func TestMaybeBundle(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{"Calculator.app", "Photos", ".config"} {
		if err := os.Mkdir(filepath.Join(dir, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "run.command"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]bool{
		"Calculator.app": true, "Calculator.app/": true, "Photos": false, ".config": false, "run.command": false, "missing.app": false,
	} {
		if got := maybeBundle(filepath.Join(dir, name)); got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
}
