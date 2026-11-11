package deeplink

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/platform"
)

// handlerFile is the app's x-scheme-handler entry in the user's applications folder.
const handlerFile = "org.rclone.ui-handler.desktop"

// Register makes exe open rclone:// links for this user. It writes a hidden .desktop entry in
// $XDG_DATA_HOME/applications and runs `xdg-mime default`. deb and rpm declare the scheme in their
// own .desktop file, so this is for the AppImage, whose path is only known at run time. The entry
// is rewritten at every start in case the file moved.
func Register(exe string) error {
	if exe == "" {
		return errors.New("no executable to register")
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		data = filepath.Join(home, ".local", "share")
	}
	dir := filepath.Join(data, "applications")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	entry := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Rclone UI",
		"Exec=" + QuoteExec(exe) + " %u",
		"Terminal=false",
		"NoDisplay=true",
		"MimeType=x-scheme-handler/" + Scheme + ";",
		"",
	}, "\n")
	path := filepath.Join(dir, handlerFile)
	if old, err := os.ReadFile(path); err != nil || string(old) != entry {
		if err := os.WriteFile(path, []byte(entry), 0o644); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Run the host's tools in the host's environment, because under an AppImage they would read
	// the AppImage's data directories.
	if err := platform.HostCommand(ctx, "xdg-mime", "default", handlerFile, "x-scheme-handler/"+Scheme).Run(); err != nil {
		return err
	}
	_ = platform.HostCommand(ctx, "update-desktop-database", dir).Run()
	return nil
}
