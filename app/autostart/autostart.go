// Package autostart starts the app at login through Wails' autostart, which uses SMAppService or a
// LaunchAgent on macOS, HKCU\…\Run on Windows, and an XDG autostart entry on Linux.
//
// Under an AppImage, this package writes the XDG entry itself (see entry.go), because Wails' entry
// names the executable inside the AppImage's mount, which has a new path at every start. It does
// the same under Flatpak, writing to the host's autostart folder, because Wails' entry would end
// up in the sandbox's config folder, which the session never reads.
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

// Identifier is the name of the app's registration. It is the launchd label (the bundle's
// SMAppService entry doesn't need one), the Run value on Windows, and the .desktop file name on
// Linux.
const Identifier = "org.rclone.ui"

// identifier returns the name of this copy's registration. A portable copy gets a name of its own
// (portableIdentifier), because Windows keeps one Run value per name. With the app's name,
// turning on Start at login in a portable copy would replace an installed copy's entry, and the
// other way round.
func identifier() string {
	if root, ok := datadir.Portable(); ok {
		return portableIdentifier(root)
	}
	return Identifier
}

// portableIdentifier names the registration of the portable copy in root after a hash of the
// folder, so that every portable copy has its own. Windows ignores the case of a path, so the
// hash does too.
func portableIdentifier(root string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root))))
	return Identifier + ".portable-" + hex.EncodeToString(sum[:4])
}

// own returns the entry that this package writes itself (see entry.go), or nil where Wails'
// registration starts the app.
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
