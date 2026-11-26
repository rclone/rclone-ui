package autostart

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/app/deeplink"
	"github.com/rclone/rclone-ui/app/platform"
)

type entry struct {
	file string
	argv []string
}

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

// Wails writes its entry at the same path.
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

// /app/bin/rcui exists only inside the sandbox, so the entry starts the app through flatpak run.
// When the session sets XDG_CONFIG_HOME, Flatpak passes it in as HOST_XDG_CONFIG_HOME, and $HOME
// is the host's.
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

func (e entry) remove() error { return removeFile(e.file) }

func removeFile(file string) error {
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

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
