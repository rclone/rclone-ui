package autostart

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/app/deeplink"
	"github.com/rclone/rclone-ui/app/platform"
)

// This file writes the XDG autostart entries that this package manages itself (see the package
// comment). Under an AppImage, it is the file that Wails would write,
// <XDG_CONFIG_HOME or ~/.config>/autostart/org.rclone.ui.desktop, but with the AppImage in Exec.
// Under Flatpak, the entry goes in the host's autostart folder (the startup gate asks for access
// to it, see platform.FlatpakMissing). It starts the app through flatpak run, because
// /app/bin/rcui exists only inside the sandbox. The code builds on every OS so that the tests run
// everywhere.

type entry struct {
	file string
	argv []string
}

// configDir is the XDG config folder: $XDG_CONFIG_HOME, or ~/.config.
func configDir(xdgConfigHome string) (string, error) {
	if xdgConfigHome != "" {
		return xdgConfigHome, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

// entryFile returns the path of the entry that Wails writes, which is also the one written under
// an AppImage.
func entryFile() (string, error) {
	dir, err := configDir(os.Getenv("XDG_CONFIG_HOME"))
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "autostart", Identifier+".desktop"), nil
}

func appImageEntry(img string) (entry, error) {
	file, err := entryFile()
	if err != nil {
		return entry{}, err
	}
	return entry{file: file, argv: []string{img}}, nil
}

// flatpakEntry returns an entry in the host's autostart folder that starts the Flatpak at login.
// When the session sets XDG_CONFIG_HOME, Flatpak passes it in as HOST_XDG_CONFIG_HOME, and $HOME
// is the host's. The file is <Flatpak ID>.flatpak.desktop, so that it never is the entry of a
// package install of the app (org.rclone.ui.desktop), which has the same ID.
func flatpakEntry() (entry, error) {
	dir, err := configDir(os.Getenv("HOST_XDG_CONFIG_HOME"))
	if err != nil {
		return entry{}, err
	}
	id := os.Getenv("FLATPAK_ID")
	if id == "" {
		id = platform.FlatpakAppID
	}
	return entry{
		file: filepath.Join(dir, "autostart", id+".flatpak.desktop"),
		argv: []string{"flatpak", "run", id},
	}, nil
}

func (e entry) execLine() string {
	quoted := make([]string, len(e.argv))
	for i, a := range e.argv {
		quoted[i] = deeplink.QuoteExec(a)
	}
	return "Exec=" + strings.Join(quoted, " ")
}

func (e entry) write() error {
	if err := os.MkdirAll(filepath.Dir(e.file), 0o755); err != nil {
		return err
	}
	contents := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Rclone UI",
		e.execLine(),
		"X-GNOME-Autostart-enabled=true",
		"Hidden=false",
		"NoDisplay=false",
		"Terminal=false",
		"",
	}, "\n")
	return os.WriteFile(e.file, []byte(contents), 0o644)
}

// remove removes the entry. A missing entry is not an error.
func (e entry) remove() error { return removeFile(e.file) }

func removeFile(file string) error {
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// enabled reports whether the entry runs its command line at login. That means the file exists
// with that Exec line, and the desktop hasn't turned it off.
func (e entry) enabled() (bool, error) {
	b, err := os.ReadFile(e.file)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	contents := string(b)
	has := false
	for line := range strings.SplitSeq(contents, "\n") {
		if strings.TrimSpace(line) == e.execLine() {
			has = true
			break
		}
	}
	return has && !disabled(contents), nil
}

// disabled reports whether a desktop turned an autostart entry off, either with Hidden=true (the
// XDG way) or with X-GNOME-Autostart-enabled=false (GNOME's switches).
func disabled(contents string) bool {
	for line := range strings.SplitSeq(contents, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key, value = strings.TrimSpace(key), strings.TrimSpace(value); key {
		case "Hidden":
			if value == "true" {
				return true
			}
		case "X-GNOME-Autostart-enabled":
			if value == "false" {
				return true
			}
		}
	}
	return false
}
