package interaction

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -x objective-c
#cgo LDFLAGS: -mmacosx-version-min=12.0 -framework Cocoa
#import <Cocoa/Cocoa.h>

static void rcuiActivate(void) {
	[NSApp activateIgnoringOtherApps:YES];
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// The app runs as an accessory, often with no window, so otherwise a dialog would open behind the
// app the user is in.
func activate() {
	application.InvokeSync(func() { C.rcuiActivate() })
}
