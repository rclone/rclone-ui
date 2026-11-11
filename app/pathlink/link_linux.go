package pathlink

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/i18n"
)

func newLinker() (*Linker, error) {
	if platform.IsFlatpak() {
		return &Linker{path: envPath, unsupported: i18n.M("Rclone UI runs in a Flatpak sandbox, which a terminal can't run it from. "+
			"`flatpak run --command=rcui %s <rclone arguments>` runs its rclone.", platform.FlatpakAppID),
			command: "flatpak run --command=rcui " + platform.FlatpakAppID}, nil
	}
	data, err := datadir.Default()
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	exe, err := platform.Executable()
	if err != nil {
		return nil, err
	}
	// Inside an AppImage, the executable is in a mount that disappears when the process exits.
	// The image file itself stays, and the runtime passes on the name it was called by (see
	// main.go).
	if img, dir := os.Getenv("APPIMAGE"), os.Getenv("APPDIR"); img != "" && dir != "" && strings.HasPrefix(exe, filepath.Clean(dir)+"/") {
		exe = img
	}
	return &Linker{
		exe:     exe,
		link:    filepath.Join(home, ".local", "bin", "rclone"),
		pointer: filepath.Join(data, "bin", "rclone"),
		path:    envPath,
	}, nil
}
