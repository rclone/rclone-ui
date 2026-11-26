package platform

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const flatpakInfo = "/.flatpak-info"

const FlatpakAppID = "org.rclone.ui"

const GnomeShellExtensions = "org.gnome.Shell.Extensions"

const autostartFilesystem = "xdg-config/autostart"

// sessionBusSocket is direct access to the session bus, past Flatpak's filtering proxy. godbus
// can send messages out of serial order when goroutines share a connection. xdg-dbus-proxy 0.1.5
// (Ubuntu 24.04 and Linux Mint 22) then logs "Invalid client serial" and drops the connection, and
// the tray icon, which shares that connection, doesn't appear.
const sessionBusSocket = "session-bus"

func FlatpakOverride() string { return flatpakOverride(IsGNOME()) }

func flatpakOverride(gnome bool) string {
	cmd := "flatpak override --user --filesystem=host --filesystem=" + autostartFilesystem + ":create " +
		"--socket=" + sessionBusSocket + " "
	if gnome {
		cmd += "--talk-name=" + GnomeShellExtensions + " "
	}
	return cmd + FlatpakAppID
}

// Budgie and GNOME Flashback list GNOME after their own name, but don't run GNOME Shell.
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

type Missing struct {
	Disk       bool
	Autostart  bool
	GNOME      bool
	SessionBus bool
}

func (m Missing) Any() bool { return m.Disk || m.Autostart || m.GNOME || m.SessionBus }

func FlatpakMissing() Missing {
	if !IsFlatpak() {
		return Missing{}
	}
	b, err := os.ReadFile(flatpakInfo)
	if err != nil {
		return Missing{Disk: true, Autostart: true, GNOME: IsGNOME(), SessionBus: true}
	}
	return missing(string(b), IsGNOME())
}

func missing(info string, gnome bool) Missing {
	return Missing{
		Disk:       !grantsFilesystem(info, "host"),
		Autostart:  !grantsAutostart(info),
		GNOME:      gnome && !grantsTalk(info, GnomeShellExtensions),
		SessionBus: !grantsSocket(info, sessionBusSocket),
	}
}

func grantsSocket(info, name string) bool {
	for _, kv := range section(info, "Context") {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || strings.TrimSpace(key) != "sockets" {
			continue
		}
		for item := range strings.SplitSeq(value, ";") {
			switch strings.TrimSpace(item) {
			case name:
				return true
			case "!" + name:
				return false
			}
		}
	}
	return false
}

func grantsAutostart(info string) bool {
	for _, name := range []string{"host", "home", "xdg-config", autostartFilesystem, "~/.config", "~/.config/autostart"} {
		if grantsFilesystem(info, name) {
			return true
		}
	}
	return false
}

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
