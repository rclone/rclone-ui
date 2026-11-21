package app

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/app/platform"
)

func TestParseOptionsSkipsPSN(t *testing.T) {
	if _, err := parseOptions([]string{"-psn_0_123456"}); err != nil {
		t.Fatalf("alone: %v", err)
	}
	o, err := parseOptions([]string{"-psn_0_123456", "rclone://add-template?cmd=sync", "--hidden"})
	if err != nil {
		t.Fatalf("before a link: %v", err)
	}
	if o.link != "rclone://add-template?cmd=sync" || !o.hidden {
		t.Fatalf("link %q, hidden %v", o.link, o.hidden)
	}
	if _, err := parseOptions([]string{"--nope"}); err == nil {
		t.Fatal("an unknown flag passed")
	}
}

func TestUniqueID(t *testing.T) {
	t.Setenv("FLATPAK_ID", "")
	def := filepath.Join(t.TempDir(), "org.rclone.ui")
	if got := uniqueID("", def); got != "org.rclone.ui" {
		t.Errorf("no data dir: %q", got)
	}
	if got := uniqueID(def+string(filepath.Separator), def); got != "org.rclone.ui" {
		t.Errorf("the default data dir: %q", got)
	}
	scratch := t.TempDir()
	a, b := uniqueID(filepath.Join(scratch, "a"), def), uniqueID(filepath.Join(scratch, "b"), def)
	if a == b || !strings.HasPrefix(a, "org.rclone.ui.d") || !strings.HasPrefix(b, "org.rclone.ui.d") {
		t.Errorf("two scratch dirs: %q, %q", a, b)
	}
	if again := uniqueID(filepath.Join(scratch, "x", "..", "a"), def); again != a {
		t.Errorf("the same dir spelled otherwise: %q, %q", again, a)
	}
	for _, r := range strings.TrimPrefix(a, "org.rclone.ui.d") {
		if !strings.ContainsRune("0123456789abcdef", r) {
			t.Fatalf("%q isn't a D-Bus name", a)
		}
	}
	// A portable copy shares its lock with no other copy, even on its default data dir.
	portable := filepath.Join(scratch, "Rclone UI", "data")
	if got := uniqueID(portable, ""); !strings.HasPrefix(got, "org.rclone.ui.d") {
		t.Errorf("a portable copy: %q", got)
	}
	if other := uniqueID(filepath.Join(scratch, "copy", "data"), ""); other == uniqueID(portable, "") {
		t.Errorf("two portable copies share %q", other)
	}
	t.Setenv("FLATPAK_ID", "org.example.Flatpak")
	if got := uniqueID(filepath.Join(scratch, "a"), def); !strings.HasPrefix(got, "org.example.Flatpak.d") {
		t.Errorf("Flatpak: %q is not under the app id", got)
	}
}

func TestFlatpakNeeds(t *testing.T) {
	const one, many = "\n\nPlease grant it with this command, in your terminal:",
		"\n\nPlease grant them with this command, in your terminal:"
	for _, c := range []struct {
		m    platform.Missing
		want string
	}{
		{platform.Missing{Disk: true}, "Rclone UI needs:\n\n• Disk access to manage your files" + one},
		{platform.Missing{Disk: true, Autostart: true}, "Rclone UI needs:\n\n• Disk access to manage your files\n• Access to your autostart folder, to start when you log in" + many},
		{platform.Missing{Disk: true, Autostart: true, GNOME: true}, "Rclone UI needs:\n\n• Disk access to manage your files\n• Access to your autostart folder, to start when you log in\n" +
			"• Access to GNOME's extensions to place the Launcher" + many},
		{platform.Missing{GNOME: true}, "Rclone UI now also needs:\n\n• Access to GNOME's extensions to place the Launcher" + one},
		{platform.Missing{Autostart: true}, "Rclone UI now also needs:\n\n• Access to your autostart folder, to start when you log in" + one},
	} {
		if got := flatpakNeeds(c.m); got != c.want {
			t.Errorf("%+v:\n got %q\nwant %q", c.m, got, c.want)
		}
	}
}

// TestLinksWaitForTheScreens also checks that a link seen twice is handled once, and that a link
// whose window failed to open is tried again.
func TestLinksWaitForTheScreens(t *testing.T) {
	var l links
	var opened []string
	fail := map[string]bool{}
	handle := func(raw string) bool {
		opened = append(opened, raw)
		return !fail[raw]
	}
	l.add("rclone://a", handle)
	l.add("rclone://a", handle)
	if len(opened) != 0 {
		t.Fatalf("handled before the screens: %v", opened)
	}
	l.release(handle)
	if strings.Join(opened, ",") != "rclone://a" {
		t.Fatalf("after release: %v", opened)
	}
	l.add("rclone://a", handle)
	if len(opened) != 1 {
		t.Fatalf("a duplicate was handled: %v", opened)
	}
	fail["rclone://b"] = true
	l.add("rclone://b", handle)
	delete(fail, "rclone://b")
	l.add("rclone://b", handle)
	l.add("rclone://b", handle)
	if strings.Join(opened, ",") != "rclone://a,rclone://b,rclone://b" {
		t.Fatalf("a failed link: %v", opened)
	}
}
