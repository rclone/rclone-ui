// Package platform answers the UI role's questions about the machine: whether it runs in a
// Flatpak and with which permissions, whether the host is Linux Mint, and what the login shell's
// PATH is.
package platform

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// flatpakInfo is the file in which Flatpak describes the sandbox to the app inside it.
const flatpakInfo = "/.flatpak-info"

// FlatpakAppID is the app's ID on Flathub, which the permission command uses.
const FlatpakAppID = "org.rclone.ui"

// GnomeShellExtensions is GNOME Shell's extensions service, which the app uses to install and
// enable the launcher's GNOME extension (see app/launcher/view/linux/gnome/ensure_linux.go).
const GnomeShellExtensions = "org.gnome.Shell.Extensions"

// autostartFilesystem is the host's autostart folder, written as a Flatpak filesystem permission.
// "Start on boot" writes its entry there (see app/autostart).
const autostartFilesystem = "xdg-config/autostart"

// FlatpakOverride returns the command that grants the permissions the gate asks for (see
// FlatpakMissing). They are access to the host's files and autostart folder and, on GNOME, to
// GNOME Shell's extensions service, because an extension places the launcher's window there. The
// user grants them, rather than the manifest.
func FlatpakOverride() string { return flatpakOverride(IsGNOME()) }

func flatpakOverride(gnome bool) string {
	cmd := "flatpak override --user --filesystem=host --filesystem=" + autostartFilesystem + ":create "
	if gnome {
		cmd += "--talk-name=" + GnomeShellExtensions + " "
	}
	return cmd + FlatpakAppID
}

// IsGNOME reports whether the desktop runs GNOME Shell. That is the case when XDG_CURRENT_DESKTOP
// lists GNOME, as in "GNOME" or "ubuntu:GNOME", which a Flatpak also sees. Budgie and GNOME
// Flashback list GNOME after their own name, but don't run GNOME Shell.
func IsGNOME() bool { return isGNOME(os.Getenv("XDG_CURRENT_DESKTOP")) }

func isGNOME(current string) bool {
	gnome := false
	for d := range strings.SplitSeq(current, ":") {
		switch {
		case strings.EqualFold(d, "Budgie"), strings.EqualFold(d, "GNOME-Flashback"):
			return false
		case strings.EqualFold(d, "GNOME"):
			gnome = true
		}
	}
	return gnome
}

func IsFlatpak() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if _, err := os.Stat(flatpakInfo); err == nil {
		return true
	}
	return os.Getenv("FLATPAK_ID") != ""
}

// Missing lists the permissions granted by FlatpakOverride that the Flatpak doesn't have.
type Missing struct {
	// Disk is write access to the host's filesystem. Without it, rclone can't reach any of the
	// user's files.
	Disk bool
	// Autostart is write access to the host's autostart folder. Without it, "Start on boot" can't
	// work, because the session never reads the sandbox's own config folder.
	Autostart bool
	// GNOME is access to GNOME Shell's extensions service, on GNOME. Without it, the launcher's
	// extension can't be installed, and there is no other way to place the launcher's window.
	GNOME bool
}

func (m Missing) Any() bool { return m.Disk || m.Autostart || m.GNOME }

// FlatpakMissing is the startup gate. It returns the permissions granted by FlatpakOverride that
// the Flatpak doesn't have, and nothing outside a Flatpak. The app doesn't start while anything
// is missing. The app doesn't create OS schedules, so it doesn't ask for host-spawn access.
func FlatpakMissing() Missing {
	if !IsFlatpak() {
		return Missing{}
	}
	b, err := os.ReadFile(flatpakInfo)
	if err != nil {
		return Missing{Disk: true, Autostart: true, GNOME: IsGNOME()}
	}
	return missing(string(b), IsGNOME())
}

func missing(info string, gnome bool) Missing {
	return Missing{
		Disk:      !grantsFilesystem(info, "host"),
		Autostart: !grantsAutostart(info),
		GNOME:     gnome && !grantsTalk(info, GnomeShellExtensions),
	}
}

// grantsAutostart reports whether the Flatpak may write to the host's autostart folder. That
// permission can be granted directly, or as part of access to the host's files, the home folder
// or the config folder.
func grantsAutostart(info string) bool {
	for _, name := range []string{"host", "home", "xdg-config", autostartFilesystem, "~/.config", "~/.config/autostart"} {
		if grantsFilesystem(info, name) {
			return true
		}
	}
	return false
}

// grantsFilesystem checks one permission in the [Context] filesystems= list of a .flatpak-info.
// "name", "name:rw" or "name:create" grant it, while "name:ro" or a "!name" override deny it.
func grantsFilesystem(info, name string) bool {
	for _, kv := range section(info, "Context") {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || strings.TrimSpace(key) != "filesystems" {
			continue
		}
		for item := range strings.SplitSeq(value, ";") {
			item = strings.TrimSpace(item)
			denied := strings.HasPrefix(item, "!")
			path, mode, _ := strings.Cut(strings.TrimPrefix(item, "!"), ":")
			if strings.TrimSuffix(path, "/") != name {
				continue
			}
			return !denied && mode != "ro"
		}
	}
	return false
}

// grantsTalk is true when [Session Bus Policy] lets the app talk to (or own) name.
func grantsTalk(info, name string) bool {
	for _, kv := range section(info, "Session Bus Policy") {
		key, value, ok := strings.Cut(kv, "=")
		if ok && strings.TrimSpace(key) == name {
			v := strings.TrimSpace(value)
			return v == "talk" || v == "own"
		}
	}
	return false
}

// section returns the trimmed, non-comment lines of one [name] section of an ini file.
func section(ini, name string) []string {
	var lines []string
	in := false
	sc := bufio.NewScanner(strings.NewReader(ini))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			in = line == "["+name+"]"
			continue
		}
		if in {
			lines = append(lines, line)
		}
	}
	return lines
}

// IsLinuxMint reports whether the host runs Linux Mint, whose panel needs the padded tray icons.
// In a Flatpak, the host's os-release is under /run/host.
func IsLinuxMint() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	paths := []string{"/etc/os-release", "/usr/lib/os-release"}
	if IsFlatpak() {
		paths = append([]string{"/run/host/os-release"}, paths...)
	}
	for _, p := range paths {
		if b, err := os.ReadFile(p); err == nil {
			return osReleaseIsMint(string(b))
		}
	}
	return false
}

func osReleaseIsMint(osRelease string) bool {
	for line := range strings.SplitSeq(osRelease, "\n") {
		line = strings.TrimSpace(line)
		if line == "ID=linuxmint" || line == `ID="linuxmint"` {
			return true
		}
	}
	return false
}

// Executable returns the absolute path of this process's executable, with symlinks resolved.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}
