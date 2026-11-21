//go:build darwin

package darwin

// Reading the clipboard on macOS. From macOS 15.4, reading the general pasteboard outside of a
// paste prompts the user. This is pasteboard privacy, controlled by the "Paste from Other Apps"
// setting. Detecting what kind of content the pasteboard holds doesn't prompt, and neither does
// reading its change count. So the launcher only detects whether there is a link, and reads the
// link when the user chooses the suggestion.

import (
	"runtime"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Values of NSPasteboardAccessBehavior (macOS 15.4).
const (
	accessAlwaysAllow = 2
	accessAlwaysDeny  = 3
)

// detectWait is how long a peek waits for the pasteboard's pattern detection, which replies on
// its own queue.
const detectWait = 200 * time.Millisecond

var (
	clipOnce sync.Once
	webURL   objc.ID // NSPasteboardDetectionPatternProbableWebURL, or 0 before macOS 15.4

	poolOnce sync.Once
	poolPush func() uintptr
	poolPop  func(uintptr)
)

func poolSetup() {
	if objcLib, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_GLOBAL|purego.RTLD_NOW); err == nil {
		purego.RegisterLibFunc(&poolPush, objcLib, "objc_autoreleasePoolPush")
		purego.RegisterLibFunc(&poolPop, objcLib, "objc_autoreleasePoolPop")
	}
}

// autoreleased runs fn inside its own autorelease pool, on a single OS thread. Off the main
// thread there is no pool, so anything fn autoreleases would leak. A pool belongs to the thread
// that pushed it, but a goroutine that blocks, such as detectLink waiting for the pasteboard, can
// resume on another thread. Popping the pool there would pop that thread's pools, or none, and
// cause a crash later. So the goroutine stays locked to its thread from the push to the pop.
func autoreleased(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	poolOnce.Do(poolSetup)
	if poolPush == nil {
		fn()
		return
	}
	pool := poolPush()
	defer poolPop(pool)
	fn()
}

func clipSetup() {
	if appKit, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_NOW); err == nil {
		if addr, err := purego.Dlsym(appKit, "NSPasteboardDetectionPatternProbableWebURL"); err == nil && addr != 0 {
			webURL = **(**objc.ID)(unsafe.Pointer(&addr)) // the NSString that the constant holds
		}
	}
}

// PeekClipboard returns what the launcher can learn about the clipboard without macOS prompting
// the user: the change count, which tells one copy apart from the next, and whether it holds a
// link. When reading doesn't prompt, it also returns the text. That is the case before macOS 15.4,
// or when the user always allows Rclone UI to paste. It can be called from any thread.
func PeekClipboard() (text string, link bool, count string) {
	autoreleased(func() { text, link, count = peek() })
	return text, link, count
}

func peek() (text string, link bool, count string) {
	clipOnce.Do(clipSetup)
	pb := msg(class("NSPasteboard"), "generalPasteboard")
	count = strconv.Itoa(objc.Send[int](pb, sel("changeCount")))
	access := -1 // no pasteboard privacy, so reading doesn't prompt
	if msgBool(pb, "respondsToSelector:", sel("accessBehavior")) {
		access = objc.Send[int](pb, sel("accessBehavior"))
	}
	switch access {
	case -1, accessAlwaysAllow:
		if s := msg(pb, "stringForType:", nsString("public.utf8-plain-text")); s != 0 {
			text = goString(s)
		}
		return text, false, count
	case accessAlwaysDeny:
		return "", false, count
	}
	return "", detectLink(pb), count
}

func detectLink(pb objc.ID) bool {
	if webURL == 0 || !msgBool(pb, "respondsToSelector:", sel("detectPatternsForPatterns:completionHandler:")) {
		return false
	}
	return detect(func(done objc.Block) {
		msg(pb, "detectPatternsForPatterns:completionHandler:", msg(class("NSSet"), "setWithObject:", webURL), done)
	})
}

// detect gives each call its own completion handler. A late reply, which arrives after its peek
// gave up, then can't be taken as the reply to the next peek, which may be about a different copy.
func detect(ask func(done objc.Block)) bool {
	found := make(chan bool, 1)
	done := objc.NewBlock(func(_ objc.Block, patterns, _ objc.ID) {
		guard("detectPatterns", func() { found <- patterns != 0 && msgBool(patterns, "containsObject:", webURL) })
	})
	// The pasteboard keeps its own copy of the block until it replies.
	defer done.Release()
	ask(done)
	select {
	case f := <-found:
		return f
	case <-time.After(detectWait):
		return false
	}
}
