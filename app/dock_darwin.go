package app

import "github.com/wailsapp/wails/v3/pkg/services/dock"

var macDock = dock.New()

// showInDock shows the app's icon in the Dock and the app switcher, or hides it so that the app
// lives in the menu bar only. It waits for the main thread, so it must not be called from there.
func showInDock(show bool) {
	if show {
		macDock.ShowAppIcon()
	} else {
		macDock.HideAppIcon()
	}
}
