package update

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/i18n"
)

// For an AppImage, the runtime sets $APPIMAGE and $APPDIR, and the executable runs from $APPDIR.
func detectInstall() (InstallType, string, i18n.Text) {
	if platform.IsFlatpak() {
		return TypeFlatpak, "", i18n.Text{}
	}
	exe, err := platform.Executable()
	if err != nil {
		return TypeUnmanaged, "", i18n.Text{}
	}
	if img, dir := os.Getenv("APPIMAGE"), os.Getenv("APPDIR"); img != "" && dir != "" && strings.HasPrefix(exe, filepath.Clean(dir)+"/") {
		if unix.Access(filepath.Dir(img), unix.W_OK) != nil {
			return TypeAppImage, img, i18n.M("The folder %s isn't writable: move the AppImage to a folder you own to update it.", filepath.Dir(img))
		}
		return TypeAppImage, img, i18n.Text{}
	}
	if owns("dpkg-query", "-S", exe) {
		return TypeDeb, exe, i18n.Text{}
	}
	if owns("rpm", "-qf", exe) {
		return TypeRPM, exe, i18n.Text{}
	}
	return TypeUnmanaged, exe, i18n.Text{}
}

func owns(tool string, args ...string) bool {
	if _, err := exec.LookPath(tool); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, tool, args...).Run() == nil
}
