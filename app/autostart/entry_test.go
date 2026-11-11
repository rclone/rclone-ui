package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppImageEntry(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	file := filepath.Join(config, "autostart", "org.rclone.ui.desktop")
	img := "/home/me/My Apps/Rclone UI 100%.AppImage"
	e, err := appImageEntry(img)
	if err != nil {
		t.Fatal(err)
	}
	if e.file != file {
		t.Fatalf("the entry is at %s", e.file)
	}
	if on, err := e.enabled(); err != nil || on {
		t.Fatalf("no entry: %v, %v", on, err)
	}
	if err := e.write(); err != nil {
		t.Fatal(err)
	}
	if on, err := e.enabled(); err != nil || !on {
		t.Fatalf("written: %v, %v", on, err)
	}
	other, _ := appImageEntry("/home/me/Other.AppImage")
	if on, _ := other.enabled(); on {
		t.Error("the entry starts another AppImage")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	contents := string(b)
	if !strings.Contains(contents, "\nExec=\"/home/me/My Apps/Rclone UI 100%%.AppImage\"\n") {
		t.Errorf("the entry is\n%s", contents)
	}
	for _, off := range [][2]string{
		{"Hidden=false", "Hidden=true"},
		{"X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"},
	} {
		if err := os.WriteFile(file, []byte(strings.Replace(contents, off[0], off[1], 1)), 0o644); err != nil {
			t.Fatal(err)
		}
		if on, err := e.enabled(); err != nil || on {
			t.Errorf("%s: %v, %v", off[1], on, err)
		}
	}
	if err := e.remove(); err != nil {
		t.Fatal(err)
	}
	if on, err := e.enabled(); err != nil || on {
		t.Errorf("removed: %v, %v", on, err)
	}
	if err := e.remove(); err != nil {
		t.Errorf("removing no entry: %v", err)
	}
}

func TestFlatpakEntry(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".var", "app", "org.rclone.ui", "config"))
	t.Setenv("HOST_XDG_CONFIG_HOME", "")
	t.Setenv("FLATPAK_ID", "org.rclone.ui")

	e, err := flatpakEntry()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".config", "autostart", "org.rclone.ui.flatpak.desktop"); e.file != want {
		t.Errorf("the entry is at %s, want %s", e.file, want)
	}
	if err := e.write(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(e.file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "\nExec=\"flatpak\" \"run\" \"org.rclone.ui\"\n") {
		t.Errorf("the entry is\n%s", b)
	}
	if on, err := e.enabled(); err != nil || !on {
		t.Errorf("written: %v, %v", on, err)
	}
	// An entry that Wails wrote in the sandbox doesn't count as the host's entry.
	sandbox, _ := appImageEntry("/app/bin/rcui")
	if on, _ := sandbox.enabled(); on {
		t.Error("the sandbox has an entry")
	}

	t.Setenv("HOST_XDG_CONFIG_HOME", filepath.Join(home, "conf"))
	if e, _ := flatpakEntry(); e.file != filepath.Join(home, "conf", "autostart", "org.rclone.ui.flatpak.desktop") {
		t.Errorf("with the host's XDG_CONFIG_HOME the entry is at %s", e.file)
	}
}
