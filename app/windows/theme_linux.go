package windows

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// setTheme does nothing on Linux. GTK's dark preference applies to the whole application, not to
// one window, so the pages' own CSS applies the theme.
func setTheme(unsafe.Pointer, string) {}

// windowsTheme returns SystemDefault, because the creation theme is an option only on Windows.
func windowsTheme(string) application.Theme { return application.SystemDefault }
