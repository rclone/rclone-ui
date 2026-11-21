package windows

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -x objective-c
#cgo LDFLAGS: -mmacosx-version-min=12.0 -framework Cocoa
#import <Cocoa/Cocoa.h>

static void rcuiSetAppearance(void *window, int mode) {
	NSWindow *w = (NSWindow *)window;
	if (mode == 0) {
		w.appearance = nil;
	} else {
		w.appearance = [NSAppearance appearanceNamed:(mode == 1 ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua)];
	}
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// setTheme sets the NSWindow's appearance. It must run on the main thread.
func setTheme(native unsafe.Pointer, theme string) {
	C.rcuiSetAppearance(native, C.int(themeMode(theme)))
}

// windowsTheme returns SystemDefault, because the creation theme is an option only on Windows.
func windowsTheme(string) application.Theme { return application.SystemDefault }
