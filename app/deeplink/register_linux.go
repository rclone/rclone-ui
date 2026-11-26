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

const handlerFile = "org.rclone.ui-handler.desktop"

// Register makes exe open rclone:// links for this user.
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
	if err := platform.HostCommand(ctx, "xdg-mime", "default", handlerFile, "x-scheme-handler/"+Scheme).Run(); err != nil {
		return err
	}
	_ = platform.HostCommand(ctx, "update-desktop-database", dir).Run()
	return nil
}
