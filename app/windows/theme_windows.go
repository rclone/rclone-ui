package windows

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
)

// windowsTheme returns the theme that a new window is created with (see base).
func windowsTheme(theme string) application.Theme {
	return creationTheme(theme, w32.IsCurrentlyDarkMode())
}

var (
	dwmapi                = windows.NewLazySystemDLL("dwmapi.dll")
	dwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

// DWMWA_USE_IMMERSIVE_DARK_MODE, and the value it had before Windows 10 20H1.
const (
	dwmaDarkMode       = 20
	dwmaDarkModeLegacy = 19
)

// setTheme makes the window's title bar dark or light. "" follows the system's app mode.
func setTheme(native unsafe.Pointer, theme string) {
	if dwmSetWindowAttribute.Find() != nil {
		return
	}
	var dark int32
	if darkTitleBar(theme, w32.IsCurrentlyDarkMode()) {
		dark = 1
	}
	hwnd := uintptr(native)
	if r, _, _ := dwmSetWindowAttribute.Call(hwnd, dwmaDarkMode, uintptr(unsafe.Pointer(&dark)), 4); r != 0 {
		_, _, _ = dwmSetWindowAttribute.Call(hwnd, dwmaDarkModeLegacy, uintptr(unsafe.Pointer(&dark)), 4)
	}
}
