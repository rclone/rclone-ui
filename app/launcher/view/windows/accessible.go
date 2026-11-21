//go:build windows

package windows

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// The rows are drawn directly, so a screen reader can't read them. A live region lets Win32 UI
// have text announced without implementing its own UI Automation provider. The view uses a STATIC
// child window whose text is the selected row. It is marked as a live region through
// IAccPropServices, and the view sends EVENT_OBJECT_LIVEREGIONCHANGED on each change. UIA's own
// UiaRaiseNotificationEvent would need a custom provider, because the provider returned by
// UiaHostProviderFromHwnd can't raise events.

var (
	clsidAccPropServices = windows.GUID{Data1: 0xb5f8350b, Data2: 0x0548, Data3: 0x48b1, Data4: [8]byte{0xa6, 0xee, 0x88, 0xbd, 0x00, 0xb4, 0xa5, 0xe7}}
	iidIAccPropServices  = windows.GUID{Data1: 0x6e26e776, Data2: 0x04f0, Data3: 0x495d, Data4: [8]byte{0x80, 0xe4, 0x33, 0x30, 0x35, 0x2e, 0x31, 0x69}}
	liveSettingProperty  = windows.GUID{Data1: 0xc12bcd8e, Data2: 0x2a8e, Data3: 0x4950, Data4: [8]byte{0x8a, 0xe7, 0x36, 0x25, 0x11, 0x1d, 0x58, 0xeb}}
)

const (
	eventObjectLiveRegionChanged = 0x8019
	objidClient                  = 0xFFFFFFFC // -4
	childidSelf                  = 0
	liveAssertive                = 2 // announced at once, as the selection moves
	vtI4                         = 3
	clsctxInprocServer           = 1
	ssNoPrefix                   = 0x0080
)

// liveRegion is the STATIC window that a screen reader reads the selected row from.
type liveRegion struct {
	hwnd   uintptr
	props  uintptr // IAccPropServices, created on the first announcement
	marked bool    // the STATIC has been marked as a live region
	said   string
}

// newLiveRegion creates the STATIC window. It is one pixel in the window's corner, which DWM
// rounds off, and has the same colour as the band behind it (WM_CTLCOLORSTATIC). It isn't hidden,
// because screen readers skip hidden windows.
func newLiveRegion(parent, instance uintptr) *liveRegion {
	class, _ := windows.UTF16PtrFromString("STATIC")
	empty, _ := windows.UTF16PtrFromString("")
	h, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(empty)),
		wsChild|wsVisible|ssNoPrefix, 0, 0, 1, 1, parent, 0, instance, 0)
	return &liveRegion{hwnd: h}
}

// say has text announced once. The same text is not announced again, such as after a render that
// didn't move the selection.
func (l *liveRegion) say(text string) {
	if l == nil || l.hwnd == 0 || text == l.said {
		return
	}
	l.said = text
	if text == "" || !l.mark() {
		return
	}
	setWindowText(l.hwnd, text)
	_, _, _ = procNotifyWinEvent.Call(eventObjectLiveRegionChanged, l.hwnd, objidClient, childidSelf)
}

// forget makes the next announcement happen even if it repeats the last one. It is called when
// the launcher is hidden.
func (l *liveRegion) forget() {
	if l != nil {
		l.said = ""
	}
}

// mark marks the STATIC as a live region, because screen readers ignore the event from a window
// that isn't one.
func (l *liveRegion) mark() bool {
	if l.marked {
		return true
	}
	if l.props == 0 {
		// COM is already initialized on the UI thread, because WebView2 needs it. Initializing
		// it again is harmless.
		_ = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
		hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidAccPropServices)), 0, clsctxInprocServer,
			uintptr(unsafe.Pointer(&iidIAccPropServices)), uintptr(unsafe.Pointer(&l.props)))
		if failed(hr) || l.props == 0 {
			l.props = 0
			return false
		}
	}
	v := variant{VT: vtI4, Val: liveAssertive}
	l.marked = !failed(setHwndProp(l.props, l.hwnd, objidClient, childidSelf, &liveSettingProperty, &v))
	return l.marked
}
