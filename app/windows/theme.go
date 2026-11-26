package windows

import "github.com/wailsapp/wails/v3/pkg/application"

func creationTheme(theme string, systemDark bool) application.Theme {
	if darkTitleBar(theme, systemDark) {
		return application.Dark
	}
	return application.Light
}

func darkTitleBar(theme string, systemDark bool) bool {
	switch theme {
	case "dark":
		return true
	case "light":
		return false
	}
	return systemDark
}

func themeMode(theme string) int {
	switch theme {
	case "dark":
		return 1
	case "light":
		return 2
	}
	return 0
}
