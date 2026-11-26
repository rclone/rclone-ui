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

const (
	accessAlwaysAllow = 2
	accessAlwaysDeny  = 3
)

const detectWait = 200 * time.Millisecond

var (
	clipOnce sync.Once
	webURL   objc.ID

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

func PeekClipboard() (text string, link bool, count string) {
	autoreleased(func() { text, link, count = peek() })
	return text, link, count
}

func peek() (text string, link bool, count string) {
	clipOnce.Do(clipSetup)
	pb := msg(class("NSPasteboard"), "generalPasteboard")
	count = strconv.Itoa(objc.Send[int](pb, sel("changeCount")))
	access := -1
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
