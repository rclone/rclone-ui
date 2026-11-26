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

type appearance int

const (
	appearanceSystem appearance = iota
	appearanceDark
	appearanceLight
)

func themeMode(theme string) appearance {
	switch theme {
	case "dark":
		return appearanceDark
	case "light":
		return appearanceLight
	}
	return appearanceSystem
}
