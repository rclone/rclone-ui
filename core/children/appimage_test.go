package children

import (
	"os"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

const appImageLibs = "/tmp/.mount_RcloneXYZ/usr/lib/:/tmp/.mount_RcloneXYZ/usr/lib/x86_64-linux-gnu/:/usr/lib"

func TestAppImageLibraryPath(t *testing.T) {
	for _, c := range []struct {
		name string
		env  []string
		want string
		ok   bool
	}{
		{"an AppImage's", []string{"HOME=/home/u", "APPIMAGE=/home/u/Rclone-UI-4.0.0-linux-x86_64.AppImage", "LD_LIBRARY_PATH=" + appImageLibs}, appImageLibs, true},
		{"not an AppImage's", []string{"LD_LIBRARY_PATH=/opt/lib"}, "/opt/lib", false},
		{"an empty APPIMAGE", []string{"APPIMAGE=", "LD_LIBRARY_PATH=/opt/lib"}, "/opt/lib", false},
		{"an AppImage with none", []string{"APPIMAGE=/home/u/Rclone-UI-4.0.0-linux-x86_64.AppImage"}, "", true},
	} {
		if got, ok := appImageLibraryPath(c.env); got != c.want || ok != c.ok {
			t.Errorf("%s: %q, %v; want %q, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestAppImageLibraryPathOfThisProcess(t *testing.T) {
	t.Setenv("APPIMAGE", "/home/u/Rclone-UI-4.0.0-linux-x86_64.AppImage")
	t.Setenv("LD_LIBRARY_PATH", appImageLibs)
	if got := AppImageLibraryPath(); got != appImageLibs {
		t.Fatalf("got %q, want %q", got, appImageLibs)
	}
	if os.Getenv("LD_LIBRARY_PATH") != appImageLibs {
		t.Error("the app's own LD_LIBRARY_PATH was changed")
	}
	t.Setenv("APPIMAGE", "")
	if got := AppImageLibraryPath(); got != "" {
		t.Fatalf("off an AppImage: %q", got)
	}
}

func TestWithLibraryPath(t *testing.T) {
	env := []string{"HOME=/home/u", "LD_LIBRARY_PATH=/opt/lib"}
	if got := withLibraryPath(slices.Clone(env), ""); !slices.Equal(got, env) {
		t.Errorf("off an AppImage: %q", got)
	}
	want := []string{"HOME=/home/u", "LD_LIBRARY_PATH=" + appImageLibs}
	if got := withLibraryPath(slices.Clone(env), appImageLibs); !slices.Equal(got, want) {
		t.Errorf("%q, want %q", got, want)
	}
}

func TestChildrenGetTheLibraryPathBack(t *testing.T) {
	for _, c := range []struct{ name, libs, want string }{
		{"an AppImage", appImageLibs, "LD_LIBRARY_PATH " + appImageLibs + " true"},
		{"not an AppImage", "", "LD_LIBRARY_PATH /core/own true"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("LD_LIBRARY_PATH", "/core/own")
			got := newEntries()
			s := newSupervisor(t, Options{Emit: got.emit, LibraryPath: c.libs})
			spec := helperSpec("env", "env", "LD_LIBRARY_PATH")
			spec.OnDown = func(*Unit, Down) bool { return false }
			u, err := s.Start(spec)
			if err != nil {
				t.Fatal(err)
			}
			waitClosed(t, u.Done(), 10*time.Second, "the child to end")
			got.wait(t, 5*time.Second, c.want, func(e logs.Record) bool { return e.Message == c.want })
		})
	}
}
