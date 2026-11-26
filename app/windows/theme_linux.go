package windows

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// GTK's dark preference applies to the whole application, not to one window.
func setTheme(unsafe.Pointer, string) {}

func windowsTheme(string) application.Theme { return application.SystemDefault }
