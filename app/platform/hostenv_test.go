package platform

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

const testAppDir = "/tmp/.mount_RcloneX"

func appImageEnv() []string {
	app := testAppDir
	return []string{
		"HOME=/home/u",
		"PATH=" + app + "/usr/bin:" + app + "/usr/bin/:/usr/local/bin:/usr/bin",
		"LD_LIBRARY_PATH=" + app + "/usr/lib/:" + app + "/usr/lib/x86_64-linux-gnu/:",
		"XDG_DATA_DIRS=" + app + "/usr/share:/usr/share:/usr/local/share",
		"PYTHONHOME=" + app + "/usr/",
		"GDK_PIXBUF_MODULE_FILE=" + app + "/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache",
		"GTK_THEME=Adwaita:dark",
		"GDK_BACKEND=x11",
		"GSETTINGS_SCHEMA_DIR=" + app + "/usr/share/glib-2.0/schemas",
		"GIO_MODULE_DIR=/usr/lib/gio/modules",
		"APPDIR=" + app,
		"APPIMAGE=/home/u/Apps/Rclone-UI-4.0.0-linux-x86_64.AppImage",
		"LANG=en_US.UTF-8",
	}
}

func TestHostEnv(t *testing.T) {
	env := appImageEnv()
	got := hostEnv(slices.Clone(env), testAppDir)
	want := []string{
		"HOME=/home/u",
		"PATH=/usr/local/bin:/usr/bin",
		"XDG_DATA_DIRS=/usr/share:/usr/local/share",
		"GIO_MODULE_DIR=/usr/lib/gio/modules",
		"LANG=en_US.UTF-8",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if !slices.Equal(hostEnv(slices.Clone(env), ""), env) {
		t.Fatal("outside an AppImage the environment is unchanged")
	}
	// A folder whose name only starts like the AppDir's isn't inside it.
	if got := hostEnv([]string{"PATH=" + testAppDir + "2/bin"}, testAppDir); !slices.Equal(got, []string{"PATH=" + testAppDir + "2/bin"}) {
		t.Fatalf("a sibling folder: %q", got)
	}
}

func TestAppDir(t *testing.T) {
	img := "/home/u/Apps/Rclone-UI-4.0.0-linux-x86_64.AppImage"
	for _, c := range []struct {
		name, appimage, appdir, exe, want string
	}{
		{"inside", img, testAppDir, testAppDir + "/usr/bin/rcui", testAppDir},
		{"outside", img, testAppDir, "/usr/bin/xdg-open", ""},
		{"a sibling", img, testAppDir, testAppDir + "2/usr/bin/rcui", ""},
		{"unset", "", "", "/usr/bin/rcui", ""},
		{"no APPIMAGE", "", testAppDir, testAppDir + "/usr/bin/rcui", ""},
	} {
		if got := appDir(c.appimage, c.appdir, c.exe); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestHostCommandOffAppImage(t *testing.T) {
	t.Setenv("APPIMAGE", "")
	cmd := HostCommand(context.Background(), "sh", "-c", "true")
	if cmd.Env != nil {
		t.Fatalf("env %q", cmd.Env)
	}
}

func TestLookPathIn(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("AppImages are Linux's; Windows has no execute bits")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tool"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plain"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := "relative:" + filepath.Join(dir, "none") + string(filepath.ListSeparator) + dir
	if got, ok := lookPathIn("tool", path); !ok || got != filepath.Join(dir, "tool") {
		t.Errorf("tool: %q %v", got, ok)
	}
	for _, name := range []string{"plain", "sub", "missing"} {
		if got, ok := lookPathIn(name, path); ok {
			t.Errorf("%s: %q", name, got)
		}
	}
}
