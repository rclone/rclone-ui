package app

import "github.com/wailsapp/wails/v3/pkg/services/dock"

var macDock = dock.New()

// The Wails dock service waits for the main thread, so this must not be called from there.
func showInDock(show bool) {
	if show {
		macDock.ShowAppIcon()
	} else {
		macDock.HideAppIcon()
	}
}
