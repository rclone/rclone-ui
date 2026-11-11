package interaction

import (
	"os"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32            = windows.NewLazySystemDLL("user32.dll")
	procGetWindowText = user32.NewProc("GetWindowTextW")
	procSetWindowPos  = user32.NewProc("SetWindowPos")
	procSetForeground = user32.NewProc("SetForegroundWindow")
)

// raise keeps the prompt titled title above every other window while it shows, until the function
// it returns is called. zenity's prompt is an ordinary window, and the app's Startup window and
// launcher may open on top of it, so that nobody would see it. zenity has no option for this, so
// raise finds the prompt among this process's windows once it opens, and puts it on top.
func raise(title string) (stop func()) {
	done := make(chan struct{})
	go func() {
		pid := uint32(os.Getpid())
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			if h := findWindow(pid, title); h != 0 {
				const hwndTopmost = ^uintptr(0) // HWND_TOPMOST, (HWND)-1
				const swpNoMove, swpNoSize = 0x0002, 0x0001
				_, _, _ = procSetWindowPos.Call(uintptr(h), hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize)
				_, _, _ = procSetForeground.Call(uintptr(h))
				return
			}
			select {
			case <-done:
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()
	return func() { close(done) }
}

// search is what findWindow looks for, and what it found. enumWindow reads it, and searchMu keeps
// one search at a time.
var (
	searchMu sync.Mutex
	search   struct {
		pid   uint32
		title string
		found windows.HWND
	}
	enumWindows = sync.OnceValue(func() uintptr {
		// One callback for the process's life: Windows has a few thousand of them per process,
		// and every NewCallback takes one for good.
		return windows.NewCallback(func(h windows.HWND, _ uintptr) uintptr {
			var owner uint32
			if _, err := windows.GetWindowThreadProcessId(h, &owner); err != nil || owner != search.pid || !windows.IsWindowVisible(h) {
				return 1
			}
			buf := make([]uint16, 256)
			n, _, _ := procGetWindowText.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
			if windows.UTF16ToString(buf[:n]) == search.title {
				search.found = h
				return 0
			}
			return 1
		})
	})
)

// findWindow returns the visible window of process pid whose title is title, or 0.
func findWindow(pid uint32, title string) windows.HWND {
	searchMu.Lock()
	defer searchMu.Unlock()
	search.pid, search.title, search.found = pid, title, 0
	_ = windows.EnumWindows(enumWindows(), nil)
	return search.found
}
