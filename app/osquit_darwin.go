package app

/*
#cgo CFLAGS: -mmacosx-version-min=12.0 -x objective-c
#cgo LDFLAGS: -mmacosx-version-min=12.0 -framework Foundation -framework CoreServices
#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>

// rcuiCurrentQuit reads the class, the id and the quit reason (kAEQuitReason) of the Apple event
// being handled. A value is 0 when there is no event or no reason.
static void rcuiCurrentQuit(unsigned int *cls, unsigned int *evt, unsigned int *why) {
	*cls = 0;
	*evt = 0;
	*why = 0;
	NSAppleEventDescriptor *e = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
	if (e == nil) {
		return;
	}
	*cls = [e eventClass];
	*evt = [e eventID];
	NSAppleEventDescriptor *reason = [e attributeDescriptorForKeyword:kAEQuitReason];
	if (reason == nil) {
		reason = [e paramDescriptorForKeyword:kAEQuitReason];
	}
	if (reason == nil) {
		return;
	}
	OSType code = [reason typeCodeValue];
	if (code == 0) {
		code = [reason enumCodeValue];
	}
	*why = code;
}
*/
import "C"

// osEndingSession reports whether loginwindow asked the app to quit for a logout, a restart or a
// shutdown. It must run on the main thread, because it reads the Apple event that the
// applicationShouldTerminate: handler is answering.
func osEndingSession() bool {
	var cls, evt, why C.uint
	C.rcuiCurrentQuit(&cls, &evt, &why)
	return sessionEndEvent(uint32(cls), uint32(evt), uint32(why))
}
