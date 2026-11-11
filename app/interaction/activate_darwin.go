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

// activate brings the app to the front before a dialog opens. The app runs as an accessory,
// often with no window, so otherwise the dialog would open behind the app the user is in.
func activate() {
	application.InvokeSync(func() { C.rcuiActivate() })
}
