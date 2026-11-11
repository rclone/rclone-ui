package windows

import "github.com/wailsapp/wails/v3/pkg/application"

// creationTheme returns the theme that Wails creates a window with on Windows. It is the app's
// theme, or the system's current theme. It is never SystemDefault (see base).
func creationTheme(theme string, systemDark bool) application.Theme {
	if darkTitleBar(theme, systemDark) {
		return application.Dark
	}
	return application.Light
}

// darkTitleBar reports whether a window's title bar is dark. The app's theme decides, or the
// system's theme when the window follows the system ("").
func darkTitleBar(theme string, systemDark bool) bool {
	switch theme {
	case "dark":
		return true
	case "light":
		return false
	}
	return systemDark
}

// themeMode returns 0 to follow the system, 1 for dark and 2 for light.
func themeMode(theme string) int {
	switch theme {
	case "dark":
		return 1
	case "light":
		return 2
	}
	return 0
}
