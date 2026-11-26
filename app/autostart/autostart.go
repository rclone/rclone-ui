// Under an AppImage, this package writes the XDG entry itself, because Wails' entry names the
// executable inside the AppImage's mount, which has a new path at every start. Under Flatpak,
// Wails' entry would end up in the sandbox's config folder, which the session never reads.

package autostart

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/datadir"
)

const Identifier = "org.rclone.ui"

// Windows keeps one Run value per name, so a portable copy gets a name of its own.
func identifier() string {
	if root, ok := datadir.Portable(); ok {
		return portableIdentifier(root)
	}
	return Identifier
}

// Windows ignores the case of a path, so the hash does too.
func portableIdentifier(root string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root))))
	return Identifier + ".portable-" + hex.EncodeToString(sum[:4])
}

func own() (*entry, error) {
	var e entry
	var err error
	switch img := appImage(); {
	case img != "":
		e, err = appImageEntry(img)
	case platform.IsFlatpak():
		e, err = flatpakEntry()
	default:
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func Enable(app *application.App) error {
	e, err := own()
	if err != nil {
		return err
	}
	if e != nil {
		return e.write()
	}
	return app.Autostart.EnableWithOptions(application.AutostartOptions{Identifier: identifier()})
}

func Disable(app *application.App) error {
	e, err := own()
	if err != nil {
		return err
	}
	if e == nil {
		return app.Autostart.Disable()
	}
	return e.remove()
}

func IsEnabled(app *application.App) (bool, error) {
	e, err := own()
	switch {
	case err != nil:
		return false, err
	case e != nil:
		return e.enabled()
	default:
		return app.Autostart.IsEnabled()
	}
}
