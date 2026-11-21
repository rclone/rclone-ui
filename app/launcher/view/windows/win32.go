//go:build windows

package windows

import (
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// The Win32 functions that the view calls. LazyProc.Call is marked uintptrescapes, so it keeps a
// pointer that is converted in its argument list alive and in place. For that reason, those
// conversions are always written inside the call.
var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")
	shcore   = windows.NewLazySystemDLL("shcore.dll")
	shlwapi  = windows.NewLazySystemDLL("shlwapi.dll")
	d2d1     = windows.NewLazySystemDLL("d2d1.dll")
	dwrite   = windows.NewLazySystemDLL("dwrite.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")

	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procCallWindowProcW          = user32.NewProc("CallWindowProcW")
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procGetCursorPos             = user32.NewProc("GetCursorPos")
	procMonitorFromPoint         = user32.NewProc("MonitorFromPoint")
	procGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procAttachThreadInput        = user32.NewProc("AttachThreadInput")
	procBringWindowToTop         = user32.NewProc("BringWindowToTop")
	procSetFocus                 = user32.NewProc("SetFocus")
	procIsWindow                 = user32.NewProc("IsWindow")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procPeekMessageW             = user32.NewProc("PeekMessageW")
	procInvalidateRect           = user32.NewProc("InvalidateRect")
	procBeginPaint               = user32.NewProc("BeginPaint")
	procEndPaint                 = user32.NewProc("EndPaint")
	procSetTimer                 = user32.NewProc("SetTimer")
	procKillTimer                = user32.NewProc("KillTimer")
	procGetKeyState              = user32.NewProc("GetKeyState")
	procGetSysColor              = user32.NewProc("GetSysColor")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	procGetWindowTextLengthW     = user32.NewProc("GetWindowTextLengthW")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procSetWindowTextW           = user32.NewProc("SetWindowTextW")
	procKeybdEvent               = user32.NewProc("keybd_event")
	procGetAsyncKeyState         = user32.NewProc("GetAsyncKeyState")
	procSystemParametersInfoW    = user32.NewProc("SystemParametersInfoW")
	procNotifyWinEvent           = user32.NewProc("NotifyWinEvent")
	procTrackMouseEvent          = user32.NewProc("TrackMouseEvent")
	procRedrawWindow             = user32.NewProc("RedrawWindow")
	procSetWinEventHook          = user32.NewProc("SetWinEventHook")
	procUnhookWinEvent           = user32.NewProc("UnhookWinEvent")
	procGetAncestor              = user32.NewProc("GetAncestor")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW")

	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")

	procCreateFontW      = gdi32.NewProc("CreateFontW")
	procDeleteObject     = gdi32.NewProc("DeleteObject")
	procSetTextColor     = gdi32.NewProc("SetTextColor")
	procSetBkColor       = gdi32.NewProc("SetBkColor")
	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")

	procDwmSetWindowAttribute        = dwmapi.NewProc("DwmSetWindowAttribute")
	procDwmExtendFrameIntoClientArea = dwmapi.NewProc("DwmExtendFrameIntoClientArea")

	procGetDpiForMonitor = shcore.NewProc("GetDpiForMonitor")

	procSHCreateMemStream = shlwapi.NewProc("SHCreateMemStream")

	procD2D1CreateFactory   = d2d1.NewProc("D2D1CreateFactory")
	procDWriteCreateFactory = dwrite.NewProc("DWriteCreateFactory")

	procCoCreateInstance = ole32.NewProc("CoCreateInstance")

	procDragAcceptFiles = shell32.NewProc("DragAcceptFiles")
	procDragQueryFileW  = shell32.NewProc("DragQueryFileW")
	procDragFinish      = shell32.NewProc("DragFinish")
)

const (
	wmSize           = 0x0005
	wmActivate       = 0x0006
	wmSetFocus       = 0x0007
	wmPaint          = 0x000F
	wmClose          = 0x0010
	wmEraseBkgnd     = 0x0014
	wmSettingChange  = 0x001A
	wmSetFont        = 0x0030
	wmNCCalcSize     = 0x0083
	wmNCHitTest      = 0x0084
	wmNCActivate     = 0x0086
	wmNCLButtonDbl   = 0x00A3
	wmKeyDown        = 0x0100
	wmChar           = 0x0102
	wmCommand        = 0x0111
	wmSysCommand     = 0x0112
	wmTimer          = 0x0113
	wmCtlColorEdit   = 0x0133
	wmCtlColorStatic = 0x0138
	wmDropFiles      = 0x0233
	scKeyMenu        = 0xF100
	wmMouseMove      = 0x0200
	wmLButtonDown    = 0x0201
	wmMouseWheel     = 0x020A
	wmEnterSizeMove  = 0x0231
	wmExitSizeMove   = 0x0232
	wmMouseLeave     = 0x02A3
	wmDpiChanged     = 0x02E0
	emGetSel         = 0x00B0
	emSetSel         = 0x00B1
	emReplaceSel     = 0x00C2
	emSetCueBanner   = 0x1501
	enChange         = 0x0300
	waInactive       = 0
	htClient         = 1
	htCaption        = 2
	pmRemove         = 1
	gwlpWndProc      = ^uintptr(3) // -4
	hwndTopmost      = ^uintptr(0) // -1
	idcArrow         = 32512
	colorHighlight   = 13
	mdtEffectiveDpi  = 0
	monitorToNull    = 0
	monitorToNearest = 2
	vkShift          = 0x10
	vkControl        = 0x11
	vkMenu           = 0x12
	vkLButton        = 0x01
	vkRButton        = 0x02

	keyeventfKeyUp = 0x0002
	tmeLeave       = 0x0002
	rdwInvalidate  = 0x0001
	rdwUpdateNow   = 0x0100

	eventObjectShow = 0x8002
	objidWindow     = 0
	gaRoot          = 2
	gwlExStyle      = ^uintptr(19) // -20
)

const (
	wsPopup         = 0x80000000
	wsChild         = 0x40000000
	wsVisible       = 0x10000000
	wsClipChildren  = 0x02000000
	wsThickFrame    = 0x00040000
	wsExTopmost     = 0x00000008
	wsExToolWindow  = 0x00000080
	wsExNoActivate  = 0x08000000
	esAutoHScroll   = 0x0080
	csHRedraw       = 0x0002
	csVRedraw       = 0x0001
	swHide          = 0
	swShow          = 5
	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	swpFrameChanged = 0x0020
)

const (
	dwmwaTransitionsForceDisabled = 3
	dwmwaUseImmersiveDarkMode     = 20
	dwmwaWindowCornerPreference   = 33
	dwmwaSystemBackdropType       = 38
	dwmwcpRound                   = 2
	dwmsbtTransientWindow         = 3 // acrylic
)

type point struct{ X, Y int32 }

type rect struct{ Left, Top, Right, Bottom int32 }

func (r rect) width() int32  { return r.Right - r.Left }
func (r rect) height() int32 { return r.Bottom - r.Top }

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

type paintStruct struct {
	Hdc       uintptr
	Erase     int32
	Paint     rect
	Restore   int32
	IncUpdate int32
	Reserved  [32]byte
}

type msg struct {
	Hwnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       point
	LPrivate uint32
}

type margins struct{ Left, Right, Top, Bottom int32 }

type trackMouseEvent struct {
	Size      uint32
	Flags     uint32
	Track     uintptr
	HoverTime uint32
}

// packPoint packs a POINT passed by value: two LONGs in one register, on both amd64 and arm64.
func packPoint(p point) uintptr { return uintptr(uint32(p.X)) | uintptr(uint32(p.Y))<<32 }

func lowWord(v uintptr) uint32  { return uint32(v) & 0xFFFF }
func highWord(v uintptr) uint32 { return uint32(v>>16) & 0xFFFF }
func lparamX(v uintptr) int32   { return int32(int16(uint16(v))) }
func lparamY(v uintptr) int32   { return int32(int16(uint16(v >> 16))) }

func defWindowProc(hwnd, m, wp, lp uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(hwnd, m, wp, lp)
	return r
}

// sendMessage sends a message that carries no pointers. Code that sends a pointer calls the proc
// directly, so the conversion happens inside the call that keeps it alive.
func sendMessage(hwnd, m, wp, lp uintptr) uintptr {
	r, _, _ := procSendMessageW.Call(hwnd, m, wp, lp)
	return r
}

func windowRect(hwnd uintptr) rect {
	var r rect
	_, _, _ = procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func clientRect(hwnd uintptr) rect {
	var r rect
	_, _, _ = procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func cursorPos() point {
	var p point
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	return p
}

func setWindowPos(hwnd, after uintptr, x, y, w, h int32, flags uintptr) {
	_, _, _ = procSetWindowPos.Call(hwnd, after, uintptr(x), uintptr(y), uintptr(w), uintptr(h), flags)
}

func invalidate(hwnd uintptr, r *rect) {
	_, _, _ = procInvalidateRect.Call(hwnd, uintptr(unsafe.Pointer(r)), 0)
}

func keyDown(vk uintptr) bool {
	r, _, _ := procGetKeyState.Call(vk)
	return int16(r) < 0
}

func foreground() uintptr {
	r, _, _ := procGetForegroundWindow.Call()
	return r
}

func setForeground(hwnd uintptr) bool {
	r, _, _ := procSetForegroundWindow.Call(hwnd)
	return r != 0
}

func windowThread(hwnd uintptr) uintptr {
	r, _, _ := procGetWindowThreadProcessId.Call(hwnd, 0)
	return r
}

func isWindow(hwnd uintptr) bool {
	r, _, _ := procIsWindow.Call(hwnd)
	return r != 0
}

func setFocus(hwnd uintptr) { _, _, _ = procSetFocus.Call(hwnd) }

func monitorAt(p point, flags uintptr) uintptr {
	r, _, _ := procMonitorFromPoint.Call(packPoint(p), flags)
	return r
}

func workArea(monitor uintptr) (rect, bool) {
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	r, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&mi)))
	return mi.Work, r != 0
}

// monitorDpi returns the monitor's effective DPI, or 96 when Windows can't report it (before 8.1).
func monitorDpi(monitor uintptr) uint32 {
	if procGetDpiForMonitor.Find() != nil {
		return 96
	}
	var x, y uint32
	r, _, _ := procGetDpiForMonitor.Call(monitor, mdtEffectiveDpi, uintptr(unsafe.Pointer(&x)), uintptr(unsafe.Pointer(&y)))
	if int32(r) < 0 || x == 0 {
		return 96
	}
	return x
}

// windowDpi returns the window's DPI, or 96 before Windows 10 1607.
func windowDpi(hwnd uintptr) uint32 {
	if procGetDpiForWindow.Find() != nil {
		return 96
	}
	r, _, _ := procGetDpiForWindow.Call(hwnd)
	if r == 0 {
		return 96
	}
	return uint32(r)
}

func windowText(hwnd uintptr) []uint16 {
	n, _, _ := procGetWindowTextLengthW.Call(hwnd)
	buf := make([]uint16, n+1)
	got, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), n+1)
	return buf[:got]
}

func setWindowText(hwnd uintptr, text string) {
	p, err := windows.UTF16PtrFromString(text)
	if err != nil { // the text contains a NUL, which the box can't show
		return
	}
	_, _, _ = procSetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(p)))
}

// dwmSet sets a DWORD-sized DWM attribute and reports whether Windows accepted it.
func dwmSet(hwnd uintptr, attr uintptr, value uint32) bool {
	r, _, _ := procDwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	return int32(r) >= 0
}

func extendFrame(hwnd uintptr, m margins) {
	_, _, _ = procDwmExtendFrameIntoClientArea.Call(hwnd, uintptr(unsafe.Pointer(&m)))
}

// trackLeave asks Windows to post WM_MOUSELEAVE when the pointer leaves the window's client area,
// including when it moves onto the parts that hitTest treats as the title bar. The request only
// lasts for one leave, so each hover makes it again.
func trackLeave(hwnd uintptr) {
	t := trackMouseEvent{Size: uint32(unsafe.Sizeof(trackMouseEvent{})), Flags: tmeLeave, Track: hwnd}
	_, _, _ = procTrackMouseEvent.Call(uintptr(unsafe.Pointer(&t)))
}

func redrawNow(hwnd uintptr) {
	_, _, _ = procRedrawWindow.Call(hwnd, 0, 0, rdwInvalidate|rdwUpdateNow)
}

// hookShows has fn called whenever a window of this process is shown (EVENT_OBJECT_SHOW), until
// unhook. The hook is out of context, so fn runs on this thread while it processes its messages.
// It returns 0 when Windows refuses.
func hookShows(fn uintptr) uintptr {
	// WINEVENT_OUTOFCONTEXT is 0; thread 0 means any thread of the process
	r, _, _ := procSetWinEventHook.Call(eventObjectShow, eventObjectShow, 0, fn, uintptr(windows.GetCurrentProcessId()), 0, 0)
	return r
}

// unhook removes a hookShows hook. Call it on the thread that set the hook.
func unhook(hook uintptr) { _, _, _ = procUnhookWinEvent.Call(hook) }

func activatable(hwnd uintptr) bool {
	if root, _, _ := procGetAncestor.Call(hwnd, gaRoot); root != hwnd {
		return false
	}
	if shown, _, _ := procIsWindowVisible.Call(hwnd); shown == 0 {
		return false
	}
	ex, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlExStyle)
	return ex&(wsExToolWindow|wsExNoActivate) == 0
}

func sysColor(index uintptr) (r, g, b uint8) {
	c, _, _ := procGetSysColor.Call(index)
	return uint8(c), uint8(c >> 8), uint8(c >> 16)
}

// queryFont takes size in DIPs. It uses ClearType, which works because the box sits on an opaque
// band.
func queryFont(size float64, dpi uint32) uintptr {
	const fwNormal, defaultCharset, cleartype = 400, 1, 5
	face, _ := windows.UTF16PtrFromString("Segoe UI")
	h := -px(size, float64(dpi)/96)
	r, _, _ := procCreateFontW.Call(uintptr(h), 0, 0, 0, fwNormal, 0, 0, 0, defaultCharset, 0, 0, cleartype, 0,
		uintptr(unsafe.Pointer(face)))
	return r
}

func solidBrush(c colorF) uintptr {
	r, _, _ := procCreateSolidBrush.Call(uintptr(colorRef(c)))
	return r
}

// mouseDown reports whether a mouse button is down, wherever the click is. It doesn't use
// GetKeyState, which only knows about this thread's input.
func mouseDown() bool {
	for _, vk := range []uintptr{vkLButton, vkRButton} {
		if r, _, _ := procGetAsyncKeyState.Call(vk); r&0x8000 != 0 {
			return true
		}
	}
	return false
}

// Mouse wheel constants: the delta for one notch, and the system setting for how many lines a
// notch scrolls. At the ends of its range, the setting means no scrolling (0) or a whole page
// (wheelPageScroll).
const (
	wheelDelta             = 120
	spiGetWheelScrollLines = 0x0068
	wheelPageScroll        = 0xFFFFFFFF
)

func wheelLines() uint32 {
	n := uint32(3)
	if r, _, _ := procSystemParametersInfoW.Call(spiGetWheelScrollLines, 0, uintptr(unsafe.Pointer(&n)), 0); r == 0 {
		return 3
	}
	return n
}

// wheelTurn returns the delta of a WM_MOUSEWHEEL. Positive is away from the user.
func wheelTurn(wp uintptr) int32 { return int32(int16(uint16(wp >> 16))) }

// droppedFiles returns the paths from a WM_DROPFILES drop and releases the drop.
func droppedFiles(drop uintptr) []string {
	defer func() { _, _, _ = procDragFinish.Call(drop) }()
	n, _, _ := procDragQueryFileW.Call(drop, 0xFFFFFFFF, 0, 0)
	paths := make([]string, 0, n)
	for i := uintptr(0); i < n; i++ {
		size, _, _ := procDragQueryFileW.Call(drop, i, 0, 0)
		buf := make([]uint16, size+1)
		_, _, _ = procDragQueryFileW.Call(drop, i, uintptr(unsafe.Pointer(&buf[0])), size+1)
		paths = append(paths, windows.UTF16ToString(buf))
	}
	return paths
}

// keyTap presses a key, or releases it when flags includes keyeventfKeyUp, as the keyboard would.
func keyTap(vk, flags uintptr) { _, _, _ = procKeybdEvent.Call(vk, 0, flags, 0) }

// appsUseLightTheme reports the system's app mode (Settings › Personalisation › Colours). It
// returns light when Windows doesn't say, because that is the default.
func appsUseLightTheme() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return true
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err != nil || v != 0
}

func deleteObject(h uintptr) {
	if h != 0 {
		_, _, _ = procDeleteObject.Call(h)
	}
}

// peekChar removes from the queue the character that a key just handled would type.
// TranslateMessage posted it before the key was dispatched to us.
func peekChar(hwnd uintptr) {
	var m msg
	_, _, _ = procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), hwnd, wmChar, wmChar, pmRemove)
}

// memStream returns an IStream over data. SHCreateMemStream copies the data.
func memStream(data []byte) uintptr {
	if len(data) == 0 {
		return 0
	}
	r, _, _ := procSHCreateMemStream.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
	return r
}
