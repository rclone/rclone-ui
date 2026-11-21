package platform

import "testing"

func TestGrantsHostSpawn(t *testing.T) {
	cases := []struct {
		info string
		want bool
	}{
		{"[Application]\nname=org.rclone.ui\n\n[Session Bus Policy]\norg.freedesktop.Flatpak=talk\norg.freedesktop.Notifications=talk\n", true},
		{"[Session Bus Policy]\norg.freedesktop.Flatpak=own\n", true},
		{"[Session Bus Policy]\norg.freedesktop.Notifications=talk\n", false},
		{"[System Bus Policy]\norg.freedesktop.Flatpak=talk\n", false},
		{"[Session Bus Policy]\norg.freedesktop.Flatpak=none\n", false},
	}
	for _, c := range cases {
		if got := grantsTalk(c.info, "org.freedesktop.Flatpak"); got != c.want {
			t.Errorf("grantsTalk(%q) = %v, want %v", c.info, got, c.want)
		}
	}
}

func TestGrantsHostFilesystem(t *testing.T) {
	cases := []struct {
		info string
		want bool
	}{
		{"[Context]\nfilesystems=host;\n", true},
		{"[Context]\nfilesystems=xdg-download;host:rw\n", true},
		{"[Context]\nfilesystems=host:create\n", true},
		{"[Context]\nfilesystems=host:ro;\n", false},
		{"[Context]\nfilesystems=!host;host\n", false},
		{"[Context]\nfilesystems=xdg-download\n", false},
		{"[Instance]\nfilesystems=host\n", false},
		{"# comment\n[Context]\nshared=network;\nfilesystems=home;host\n", true},
	}
	for _, c := range cases {
		if got := grantsFilesystem(c.info, "host"); got != c.want {
			t.Errorf("grantsFilesystem(%q, host) = %v, want %v", c.info, got, c.want)
		}
	}
}

func TestGrantsAutostart(t *testing.T) {
	for info, want := range map[string]bool{
		"[Context]\nfilesystems=xdg-config/autostart:create;\n": true,
		"[Context]\nfilesystems=xdg-config/autostart;\n":        true,
		"[Context]\nfilesystems=xdg-config/autostart/;\n":       true,
		"[Context]\nfilesystems=host;\n":                        true,
		"[Context]\nfilesystems=home:rw;\n":                     true,
		"[Context]\nfilesystems=xdg-config;\n":                  true,
		"[Context]\nfilesystems=~/.config/autostart:create;\n":  true,
		"[Context]\nfilesystems=home:ro;xdg-config/autostart\n": true,
		"[Context]\nfilesystems=xdg-config/autostart:ro;\n":     false,
		"[Context]\nfilesystems=!host;!home;\n":                 false,
		"[Context]\nfilesystems=host:ro;xdg-download\n":         false,
		"[Context]\nfilesystems=xdg-config/git;\n":              false,
		"": false,
	} {
		if got := grantsAutostart(info); got != want {
			t.Errorf("grantsAutostart(%q) = %v, want %v", info, got, want)
		}
	}
}

func TestOsReleaseIsMint(t *testing.T) {
	if !osReleaseIsMint("NAME=\"Linux Mint\"\nID=linuxmint\nID_LIKE=ubuntu\n") {
		t.Error("plain ID not recognised")
	}
	if !osReleaseIsMint("ID=\"linuxmint\"\n") {
		t.Error("quoted ID not recognised")
	}
	if osReleaseIsMint("ID=ubuntu\nID_LIKE=debian\n") {
		t.Error("ubuntu taken for Mint")
	}
}

func TestFlatpakOverride(t *testing.T) {
	if got := flatpakOverride(false); got != "flatpak override --user --filesystem=host --filesystem=xdg-config/autostart:create org.rclone.ui" {
		t.Errorf("elsewhere: %q", got)
	}
	if got := flatpakOverride(true); got != "flatpak override --user --filesystem=host --filesystem=xdg-config/autostart:create --talk-name=org.gnome.Shell.Extensions org.rclone.ui" {
		t.Errorf("GNOME: %q", got)
	}
	if !grantsTalk("[Session Bus Policy]\norg.gnome.Shell.Extensions=talk\n", GnomeShellExtensions) {
		t.Error("an override's talk-name")
	}
	// What the override writes to .flatpak-info satisfies the gate.
	info := "[Context]\nfilesystems=host;xdg-config/autostart:create;\n[Session Bus Policy]\norg.gnome.Shell.Extensions=talk\n"
	if m := missing(info, true); m.Any() {
		t.Errorf("after the override: %+v", m)
	}
}

func TestIsGNOME(t *testing.T) {
	for in, want := range map[string]bool{
		"GNOME": true, "ubuntu:GNOME": true, "GNOME-Classic:GNOME": true, "KDE": false, "": false,
		"GNOME-Flashback:GNOME": false, "Budgie:GNOME": false, "Unity": false,
	} {
		if got := isGNOME(in); got != want {
			t.Errorf("%q: got %v", in, got)
		}
	}
}

func TestMissing(t *testing.T) {
	disk := "[Context]\nfilesystems=host;\n"
	shell := "[Session Bus Policy]\norg.gnome.Shell.Extensions=talk\n"
	for _, c := range []struct {
		info  string
		gnome bool
		want  Missing
	}{
		{"", false, Missing{Disk: true, Autostart: true}},
		{disk, false, Missing{}},
		{disk, true, Missing{GNOME: true}},
		{disk + shell, true, Missing{}},
		{shell, true, Missing{Disk: true, Autostart: true}},
		{"[Context]\nfilesystems=host:ro;\n", false, Missing{Disk: true, Autostart: true}},
		{"[Context]\nfilesystems=home;\n", false, Missing{Disk: true}},
		{"[Context]\nfilesystems=host:ro;xdg-config/autostart:create;\n", false, Missing{Disk: true}},
	} {
		if got := missing(c.info, c.gnome); got != c.want {
			t.Errorf("%q gnome=%v: missing %+v, want %+v", c.info, c.gnome, got, c.want)
		}
	}
}
