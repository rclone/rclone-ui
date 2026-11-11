//go:build windows

package windows

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"runtime/debug"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/core/i18n"
)

// View is the launcher window. There is one per process, and the window procedures find it
// through current.
type View struct {
	ev view.Events
	g  *gfx

	hwnd, edit uintptr
	editProc   uintptr // the EDIT's own window procedure, which ours passes other messages to
	font       uintptr // the query box font, at dpi
	band       uintptr // the brush of the query band, behind the box
	glass      bool    // the acrylic backdrop was applied, so the rows are drawn on a transparent window
	dark       bool    // the system's app mode
	pal        palette
	live       *liveRegion
	dpi        uint32

	snap         view.Snapshot
	visible      bool
	left, top    int32   // the window's top-left, in screen pixels
	prev         uintptr // the window that was in the foreground before Show; Hide gives it back
	settingFrame bool    // set during our own move or resize
	settingText  bool    // set during SetQuery, so the edit isn't taken for the user's
	cursor       point   // the last known pointer position, in screen pixels
	wheel        int32   // wheel delta that doesn't yet add up to a whole row
	dragFrom     rect    // the window rectangle when the user started dragging it
	spin         int     // the spinner's current step
	ticking      bool
	stopHover    bool // the pointer is on the stop-everything button
	// line is the footer line. While a swap runs, starting at swapStart, swapFrom is the line
	// being replaced.
	line, swapFrom view.Line
	swapStart      time.Time
	swapping       bool

	upAt     time.Time // when the mouse button was released, while a blur waits on it (see waitMouse)
	handOff  bool      // the next Hide passes the foreground on (see HandOff)
	showHook uintptr   // hook that watches for our windows being shown after a hand-off (see awaitWindow)
}

var current *View

var (
	wndProcCallback     = windows.NewCallback(wndProc)
	editProcCallback    = windows.NewCallback(editProc)
	windowShownCallback = windows.NewCallback(windowShown)
)

// The wait for the window that a hand-off's action opens. handOffFor is in milliseconds. It covers
// the longest time the window takes to appear, which is when its page loads or after 2 seconds,
// plus time for the action to open it.
const (
	handOffTimer = 4
	handOffFor   = 5000
)

var logger = slog.Default()

// SetLog sends the window's panic logs to l. Call it on the main thread, where the callbacks run.
func SetLog(l *slog.Logger) { logger = l }

const (
	className   = "RcuiLauncher"
	spinTimer   = 1
	mouseTimer  = 2  // waits for the mouse button after a blur, because a drag may still arrive
	swapTimer   = 3  // animates the footer swap
	spinEvery   = 80 // ms
	swapEvery   = 16 // ms per frame; Windows rounds timers up to its own interval, about 15.6 ms
	spinDots    = 8
	editID      = 1
	queryFontPt = 20.0 // DIPs
)

var transparent = colorF{}

// New builds the window, hidden. It must be called once, on the main thread.
func New(ev view.Events) (*View, error) {
	if current != nil {
		return nil, errors.New("the launcher's window exists already")
	}
	g, err := newGfx()
	if err != nil {
		return nil, err
	}
	v := &View{ev: ev, g: g, dpi: 96}
	current = v
	if err := v.build(); err != nil {
		current = nil
		return nil, err
	}
	return v, nil
}

func (v *View) build() error {
	instance, _, _ := procGetModuleHandleW.Call(0)
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	name, _ := windows.UTF16PtrFromString(className)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		Style:     csHRedraw | csVRedraw,
		WndProc:   wndProcCallback,
		Instance:  instance,
		Cursor:    cursor,
		ClassName: name,
	}
	if r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return fmt.Errorf("register the launcher's window class: %w", err)
	}
	// The title doesn't show, since the window has no title bar, but screen readers read it. It
	// keeps the language that the app started in.
	title, _ := windows.UTF16PtrFromString(i18n.T("Launcher"))
	// The window has a thick frame, although none of it shows (see WM_NCCALCSIZE). The frame keeps
	// DWM's shadow, rounded corners and backdrop, which a bare popup doesn't get. As a tool window,
	// it has no taskbar button and no Alt+Tab entry.
	hwnd, _, err := procCreateWindowExW.Call(wsExToolWindow|wsExTopmost, uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(title)), wsPopup|wsThickFrame|wsClipChildren,
		0, 0, uintptr(px(view.Width, 1)), uintptr(px(view.Height(view.Snapshot{}), 1)), 0, 0, instance, 0)
	if hwnd == 0 {
		return fmt.Errorf("create the launcher's window: %w", err)
	}
	v.hwnd = hwnd
	v.dpi = windowDpi(hwnd)

	_ = dwmSet(hwnd, dwmwaWindowCornerPreference, dwmwcpRound)
	_ = dwmSet(hwnd, dwmwaTransitionsForceDisabled, 1) // appear at once, as a launcher should
	// layout sets the frame area through which DWM shows the backdrop, because it changes with the
	// height.
	v.glass = dwmSet(hwnd, dwmwaSystemBackdropType, dwmsbtTransientWindow)
	v.applyTheme()
	setWindowPos(hwnd, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)

	edit, _ := windows.UTF16PtrFromString("EDIT")
	empty, _ := windows.UTF16PtrFromString("")
	v.edit, _, err = procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(edit)), uintptr(unsafe.Pointer(empty)),
		wsChild|wsVisible|esAutoHScroll, 0, 0, 10, 10, hwnd, editID, instance, 0)
	if v.edit == 0 {
		return fmt.Errorf("create the launcher's query box: %w", err)
	}
	// let the launcher see keys before the box does
	v.editProc, _, _ = procSetWindowLongPtrW.Call(v.edit, gwlpWndProc, editProcCallback)
	v.live = newLiveRegion(hwnd, instance)
	// Files dragged from Explorer arrive as WM_DROPFILES. The box, as a child window, passes them
	// up.
	_, _, _ = procDragAcceptFiles.Call(hwnd, 1)
	v.setFont()
	v.layout()
	return nil
}

// applyTheme follows the system's app mode. The frame's dark mode also sets the acrylic tint.
func (v *View) applyTheme() {
	v.dark = !appsUseLightTheme()
	v.pal = paletteFor(v.dark)
	dark := uint32(0)
	if v.dark {
		dark = 1
	}
	_ = dwmSet(v.hwnd, dwmwaUseImmersiveDarkMode, dark)
	old := v.band
	v.band = solidBrush(v.pal.surface)
	deleteObject(old)
	invalidate(v.hwnd, nil)
	if v.edit != 0 { // passing a null window would invalidate every window
		invalidate(v.edit, nil)
	}
}

func (v *View) setFont() {
	old := v.font
	v.font = queryFont(queryFontPt, v.dpi)
	sendMessage(v.edit, wmSetFont, v.font, 1)
	deleteObject(old)
}

func (v *View) scale() float64 { return float64(v.dpi) / 96 }

func (v *View) Show(at *view.Placement) {
	v.handOff = false
	v.stopAwaiting() // the user wants the launcher now, not the window an action opens
	was := v.dpi
	var mon uintptr
	if at != nil {
		mon = monitorAt(point{int32(at.Left) + 1, int32(at.Top) + 1}, monitorToNull)
	}
	if mon != 0 {
		v.left, v.top = int32(at.Left), int32(at.Top)
		v.dpi = monitorDpi(mon)
	} else {
		mon = monitorAt(cursorPos(), monitorToNearest)
		v.dpi = monitorDpi(mon)
		if work, ok := workArea(mon); ok {
			dx, dy := view.Centred(float64(work.width()), float64(work.height()), v.scale())
			v.left, v.top = work.Left+int32(math.Round(dx)), work.Top+int32(math.Round(dy))
		}
	}
	if v.dpi != was {
		v.g.discard()
		v.setFont()
	}
	v.visible = true
	// Record the current pointer position, so rows appearing under it don't count as a move and
	// don't change the selection.
	v.cursor = cursorPos()
	v.wheel = 0
	v.prev = foreground()
	v.layout()
	_, _, _ = procShowWindow.Call(v.hwnd, swShow)
	forceForeground(v.hwnd)
	setFocus(v.edit)
	v.tick()
}

// forceForeground makes hwnd, one of our windows, the foreground window. Windows allows this for
// the foreground process, or for the process that received the last input, such as the launcher's
// hotkey. If Windows refuses anyway, it first taps Alt, because Windows lets the foreground change
// while Alt is down, since it could be Alt+Tab. If that fails too, it attaches to the input of the
// foreground thread.
func forceForeground(hwnd uintptr) {
	if setForeground(hwnd) && foreground() == hwnd {
		return
	}
	// Use the left Alt, because the right one is AltGr on many layouts, which adds its own Ctrl.
	keyTap(vkMenu, 0)
	ok := setForeground(hwnd)
	keyTap(vkMenu, keyeventfKeyUp) // the launcher blocks the menu activation this causes (WM_SYSCOMMAND)
	if ok && foreground() == hwnd {
		return
	}
	fg := foreground()
	theirs, ours := windowThread(fg), uintptr(windows.GetCurrentThreadId())
	if fg == 0 || theirs == 0 || theirs == ours {
		return
	}
	_, _, _ = procAttachThreadInput.Call(theirs, ours, 1)
	_, _, _ = procBringWindowToTop.Call(hwnd)
	_ = setForeground(hwnd)
	_, _, _ = procAttachThreadInput.Call(theirs, ours, 0)
}

// HandOff makes the next Hide pass the foreground to the window that the running action opens
// (Platform.Activate). Call it on the main thread while the key press or click that runs the
// action is being handled. The foreground isn't given back to the window the user was in, and the
// window that the action opens is brought to the front when it appears (see awaitWindow).
func HandOff() {
	if v := current; v != nil && v.visible {
		v.handOff = true
	}
}

// Hide gives the foreground back to the window that had it before Show, unless a hand-off is
// pending. It leaves the foreground alone when the launcher doesn't have it, because the user
// clicked somewhere else.
func (v *View) Hide() {
	ours := foreground() == v.hwnd
	handOff := v.handOff
	v.handOff = false
	v.visible = false // clear it before the deactivation that Hide causes, which isn't a blur
	v.stopHover = false
	v.endSwap()
	_, _, _ = procKillTimer.Call(v.hwnd, mouseTimer)
	_, _, _ = procShowWindow.Call(v.hwnd, swHide)
	v.tick()
	v.live.forget()
	switch {
	case !ours:
	case handOff:
		v.awaitWindow()
	case v.prev != 0 && v.prev != v.hwnd && isWindow(v.prev):
		_ = setForeground(v.prev)
	}
	v.prev = 0
}

// awaitWindow watches, for up to handOffFor, for the window that a hand-off's action opens. That
// window appears only once its page has loaded. By then the key release has gone to the window
// that Windows activated when the launcher hid. Windows may then refuse our window the foreground,
// because only the foreground process or the one with the last input may change it. windowShown
// then brings the window to the foreground.
func (v *View) awaitWindow() {
	if v.showHook == 0 {
		v.showHook = hookShows(windowShownCallback)
	}
	_, _, _ = procSetTimer.Call(v.hwnd, handOffTimer, handOffFor, 0)
}

func (v *View) stopAwaiting() {
	_, _, _ = procKillTimer.Call(v.hwnd, handOffTimer)
	if v.showHook != 0 {
		unhook(v.showHook)
		v.showHook = 0
	}
}

// windowShown is called when a window of this process is shown while awaitWindow is waiting. The
// first window other than the launcher that can take the foreground is the one the action opened.
// That window has already asked for the foreground itself (Show, then Focus). If Windows refused,
// windowShown brings it to the foreground the same way Show does for the launcher.
func windowShown(_, _, hwnd, object, child, _, _ uintptr) uintptr {
	defer func() {
		if p := recover(); p != nil {
			panicked("a window shown", p)
		}
	}()
	v := current
	// object and child are LONGs, so only their low 32 bits are set
	if v == nil || v.showHook == 0 || hwnd == v.hwnd || int32(object) != objidWindow || int32(child) != childidSelf || !activatable(hwnd) {
		return 0
	}
	v.stopAwaiting()
	if foreground() != hwnd {
		forceForeground(hwnd)
	}
	return 0
}

func (v *View) Visible() bool { return v.visible }

func (v *View) SetQuery(text string, selectAll bool) {
	v.settingText = true
	setWindowText(v.edit, text)
	v.settingText = false
	if selectAll {
		sendMessage(v.edit, emSetSel, 0, ^uintptr(0))
		return
	}
	n := uintptr(len(windowText(v.edit)))
	sendMessage(v.edit, emSetSel, n, n)
}

func (v *View) Render(s view.Snapshot) {
	if s.Placeholder != v.snap.Placeholder {
		if p, err := windows.UTF16PtrFromString(s.Placeholder); err == nil {
			// show the placeholder even while the box has the caret
			_, _, _ = procSendMessageW.Call(v.edit, emSetCueBanner, 1, uintptr(unsafe.Pointer(p)))
		}
	}
	v.snap = s
	v.setLine(view.FooterLine(s))
	v.tick()
	v.layout()
	invalidate(v.hwnd, nil)
	if v.visible {
		v.live.say(announcement(s))
	}
}

// setLine makes l the footer line, animated when view.Swaps allows it. A swap that starts while
// another one runs starts from the line that was coming in.
func (v *View) setLine(l view.Line) {
	if v.visible && view.Swaps(v.line, l) {
		v.swapFrom, v.swapStart = v.line, time.Now()
		if !v.swapping {
			v.swapping = true
			_, _, _ = procSetTimer.Call(v.hwnd, swapTimer, swapEvery, 0)
		}
	}
	v.line = l
}

func (v *View) endSwap() {
	if v.swapping {
		v.swapping = false
		_, _, _ = procKillTimer.Call(v.hwnd, swapTimer)
	}
}

func (v *View) tick() {
	want := v.visible && v.snap.Status.Kind == view.StatusLoading
	if want == v.ticking {
		return
	}
	v.ticking = want
	if want {
		_, _, _ = procSetTimer.Call(v.hwnd, spinTimer, spinEvery, 0)
	} else {
		_, _, _ = procKillTimer.Call(v.hwnd, spinTimer)
	}
}

func (v *View) layout() {
	s := v.scale()
	w, h := px(view.Width, s), px(view.Height(v.snap), s)
	v.settingFrame = true
	if v.visible {
		setWindowPos(v.hwnd, hwndTopmost, v.left, v.top, w, h, swpNoActivate)
	} else {
		setWindowPos(v.hwnd, 0, 0, 0, w, h, swpNoMove|swpNoZOrder|swpNoActivate)
	}
	v.settingFrame = false
	if v.glass {
		// The rows area is part of the frame, where DWM shows the acrylic through. The query band
		// isn't, because GDI text has no alpha and would be transparent there.
		extendFrame(v.hwnd, margins{0, 0, 0, h - px(view.QueryH, s)})
	} else {
		extendFrame(v.hwnd, margins{1, 1, 1, 1}) // a thin frame is enough for DWM's shadow
	}
	setWindowPos(v.edit, 0, px(18, s), px(view.FieldTop, s), px(view.FieldW, s), px(30, s), swpNoZOrder|swpNoActivate)
}

// spinnerBox returns the spinner's box in DIPs.
func spinnerBox(s view.Snapshot) rectF {
	top := float32(view.FooterTop(s)) + 1
	return rectF{Left: 18, Top: top, Right: 18 + view.SpinSize, Bottom: top + view.SpinSize}
}

// lineBox returns the footer line's box in DIPs, with room above and below for the swap animation.
func lineBox(s view.Snapshot) rectF {
	top := float32(view.FooterTop(s))
	return rectF{Left: 18, Top: top - view.Slide, Right: 18 + view.FooterW, Bottom: top + 18 + view.Slide}
}

// stopBox returns the stop-everything button's box, in DIPs.
func stopBox(s view.Snapshot) rectF {
	top := float32(view.StopTop(s))
	return rectF{Left: view.StopLeft, Top: top, Right: view.StopLeft + view.StopSize, Bottom: top + view.StopSize}
}

// invalidateBox makes the window repaint r, given in DIPs, with a margin for antialiased edges.
func (v *View) invalidateBox(r rectF) {
	s := v.scale()
	pr := rect{px(float64(r.Left), s) - 2, px(float64(r.Top), s) - 2, px(float64(r.Right), s) + 2, px(float64(r.Bottom), s) + 2}
	invalidate(v.hwnd, &pr)
}

// paint draws the part of the snapshot inside dirty, given in DIPs. The rest keeps the pixels of
// the last frame.
func (v *View) paint(dirty rectF) {
	g := v.g
	if !g.target(v.hwnd, v.dpi, v.glass) {
		return
	}
	s, p := v.snap, v.pal
	if all := v.dips(clientRect(v.hwnd)); g.whole || covers(dirty, all) {
		dirty = all
		g.frame()
	}
	bg := p.surface
	if v.glass {
		bg = transparent
	}
	g.begin(dirty, bg)
	if band := (rectF{0, 0, view.Width, view.QueryH}); overlaps(dirty, band) {
		if v.glass {
			g.fillRounded(band, 0, p.surface)
		}
		g.fillRounded(rectF{0, view.QueryH - 1, view.Width, view.QueryH}, 0, p.separator)
	}
	if header := (rectF{18, view.QueryH, view.Width - 18, view.QueryH + 16}); s.Header != "" && overlaps(dirty, header) {
		g.text(g.small, s.Header, header, p.secondary, nil)
	}
	if list := (rectF{0, float32(view.RowsTop(s.Header != "")), view.Width, float32(view.ListBottom(s))}); overlaps(dirty, list) {
		v.paintList(list, dirty)
	}
	if overlaps(dirty, lineBox(s)) {
		v.paintFooter()
	}
	if overlaps(dirty, stopBox(s)) {
		v.paintStop()
	}
	if !g.end() {
		g.discard()
		invalidate(v.hwnd, nil)
	}
}

// dips converts r from client pixels to DIPs.
func (v *View) dips(r rect) rectF {
	s := float32(v.scale())
	return rectF{float32(r.Left) / s, float32(r.Top) / s, float32(r.Right) / s, float32(r.Bottom) / s}
}

func overlaps(a, b rectF) bool {
	return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom
}

// covers reports whether a contains all of b.
func covers(a, b rectF) bool {
	return a.Left <= b.Left && a.Top <= b.Top && a.Right >= b.Right && a.Bottom >= b.Bottom
}

// paintList clips at the bottom of list, so the last row of a long list is drawn only in part. It
// leaves rows outside dirty as they are.
func (v *View) paintList(list, dirty rectF) {
	s, g := v.snap, v.g
	g.clip(list)
	defer g.unclip()
	for i, r := range s.Rows {
		y := float32(view.RowTop(s, i))
		top := y // the top of its group label, when it has one
		if r.Group != "" {
			top -= view.GroupH
		}
		if top >= min(list.Bottom, dirty.Bottom) { // neither this row nor any after it is drawn
			break
		}
		if y+view.RowH <= dirty.Top {
			continue
		}
		if r.Group != "" {
			label := y - view.GroupH + 5
			g.text(g.label, r.Group, rectF{18, label, view.Width - 18, label + 16}, v.pal.secondary, nil)
		}
		if y < list.Bottom {
			v.paintRow(r, i == s.Selected, y)
		}
	}
}

func (v *View) paintRow(r view.Row, selected bool, y float32) {
	g := v.g
	const inner = view.Width - 2*view.Padding
	fg, sub, icon := v.pal.text, v.pal.secondary, v.pal.icon
	if r.Danger {
		icon = hex(v.pal.critical)
	}
	if selected {
		fill := v.pal.danger
		if !r.Danger {
			hr, hg, hb := sysColor(colorHighlight)
			fill = colorF{float32(hr) / 255, float32(hg) / 255, float32(hb) / 255, 1}
		}
		g.fillRounded(rectF{view.Padding, y, view.Padding + inner, y + view.RowH - 4}, 8, fill)
		fg, sub, icon = onAccent.text, onAccent.secondary, onAccent.icon
	}
	box := float32(view.RowH - 4)
	g.icon(r.Icon, icon, view.Padding+14, y+(box-view.IconSize)/2, view.IconSize)
	titleW := float32(inner - 46 - 250)
	x := float32(view.Padding + 46)
	if r.Subtitle == "" {
		g.text(g.title, r.Title, rectF{x, y + (box-20)/2, x + titleW, y + (box+20)/2}, fg, boldRanges(r.Title, r.Bold))
	} else {
		g.text(g.title, r.Title, rectF{x, y + 4, x + titleW, y + 24}, fg, boldRanges(r.Title, r.Bold))
		g.text(g.small, r.Subtitle, rectF{x, y + 24, x + titleW, y + 40}, sub, nil)
	}
	mid := y + (box-16)/2
	g.text(g.tail, r.Tail, rectF{view.Padding + inner - 250, mid, view.Padding + inner - 70, mid + 16}, sub, nil)
	g.text(g.tail, r.Hint, rectF{view.Padding + inner - 64, mid, view.Padding + inner - 14, mid + 16}, sub, nil)
}

// paintFooter draws the footer line. During a swap, the old line moves up and out while the new
// one moves up from below into its place.
func (v *View) paintFooter() {
	if v.swapping {
		e := swapProgress(time.Since(v.swapStart))
		v.paintLine(v.swapFrom, -view.Slide*e, 1-e)
		v.paintLine(v.line, view.Slide*(1-e), e)
	} else {
		v.paintLine(v.line, 0, 1)
	}
}

// paintLine draws a footer line dy below its resting place, at the given alpha.
func (v *View) paintLine(l view.Line, dy, alpha float32) {
	p := v.pal
	top := float32(view.FooterTop(v.snap)) + dy
	x, c, text := float32(18), p.secondary, l.Status.Text
	switch l.Status.Kind {
	case view.StatusNone:
		text = l.Hints
	case view.StatusLoading:
		v.paintSpinner(dy, alpha)
		x = view.StatusLeft
	case view.StatusDone:
		c = p.success
	case view.StatusError:
		c = p.critical
	}
	c.A *= alpha
	v.g.text(v.g.small, text, rectF{x, top, 18 + view.FooterW, top + 18}, c, nil)
}

func (v *View) paintStop() {
	b, p := stopBox(v.snap), v.pal
	glyph, disc := p.muted, p.text
	disc.A = 0.07
	if v.snap.Running {
		glyph, disc = hex(p.critical), p.critical
		disc.A = 0.16
	}
	if v.stopHover {
		disc.A *= 2
	}
	const r, glyphSize = view.StopSize / 2, 14
	v.g.fillEllipse(ellipse{X: b.Left + r, Y: b.Top + r, RadiusX: r, RadiusY: r}, disc)
	v.g.icon(icons.StopAll, glyph, b.Left+(view.StopSize-glyphSize)/2, b.Top+(view.StopSize-glyphSize)/2, glyphSize)
}

// paintSpinner draws the spinner dy below its resting place, at the given alpha. The brightest
// dot moves on each tick.
func (v *View) paintSpinner(dy, alpha float32) {
	b := spinnerBox(v.snap)
	cx, cy := (b.Left+b.Right)/2, (b.Top+b.Bottom)/2+dy
	for i := 0; i < spinDots; i++ {
		x, y := spinnerDot(i)
		age := (v.spin - i + spinDots) % spinDots
		c := v.pal.text
		c.A = (1 - float32(age)/float32(spinDots)*0.85) * alpha
		v.g.fillEllipse(ellipse{X: cx + x, Y: cy + y, RadiusX: 1.6, RadiusY: 1.6}, c)
	}
}

// rowAtPixel returns the row at client y in pixels, or -1.
func (v *View) rowAtPixel(y int32) int {
	return view.RowAt(float64(y)/v.scale(), v.snap)
}

func (v *View) stopAtPixel(x, y int32) bool {
	s := v.scale()
	return view.InStop(float64(x)/s, float64(y)/s, v.snap)
}

// setStopHover asks Windows to report when the pointer leaves the window, because the pointer may
// leave it from the button.
func (v *View) setStopHover(on bool) {
	if on == v.stopHover {
		return
	}
	v.stopHover = on
	if on {
		trackLeave(v.hwnd)
	}
	v.invalidateBox(stopBox(v.snap))
}

// mouseMoved selects a row only on real pointer movement. The window appearing, or rows shifting
// under a still pointer, doesn't move the selection.
func (v *View) mouseMoved(lp uintptr) {
	if !v.visible {
		return
	}
	v.setStopHover(v.stopAtPixel(lparamX(lp), lparamY(lp)))
	p := cursorPos()
	if p == v.cursor {
		return
	}
	v.cursor = p
	if i := v.rowAtPixel(lparamY(lp)); i >= 0 && v.ev.Hover != nil {
		v.ev.Hover(i)
	}
}

// scroll scrolls as many rows per notch as the user's lines per notch setting. The smaller deltas
// from a touchpad add up to rows.
func (v *View) scroll(wp uintptr) {
	lines := wheelLines()
	if lines == 0 || v.ev.Scroll == nil {
		return
	}
	if lines == wheelPageScroll {
		lines = view.MaxRows
	}
	perRow := max(wheelDelta/int32(min(lines, wheelDelta)), 1)
	v.wheel += wheelTurn(wp)
	n := v.wheel / perRow
	v.wheel -= n * perRow
	if n != 0 {
		v.ev.Scroll(int(-n)) // turning the wheel away from the user scrolls up
	}
}

// hitTest treats the rows and the stop button as client area, and everything else (the header,
// the footer and the band's margins) as the title bar, which Windows lets the user drag. The test
// for rows only checks y, because the margins beside the rows are client area too. The query box
// handles its own hit testing.
func (v *View) hitTest(lp uintptr) uintptr {
	r := windowRect(v.hwnd)
	x, y := lparamX(lp)-r.Left, lparamY(lp)-r.Top
	if v.rowAtPixel(y) >= 0 || v.stopAtPixel(x, y) {
		return htClient
	}
	return htCaption
}

// key passes a key to the launcher and returns true when it was handled.
func (v *View) key(vk uintptr) bool {
	ctrl, shift, alt := keyDown(vkControl), keyDown(vkShift), keyDown(vkMenu)
	k, ok := keyFor(uint32(vk), ctrl, shift, alt)
	if ok && v.ev.Key != nil && v.ev.Key(k) {
		return true
	}
	if ctrl && !alt && vk == 'A' { // the EDIT has no built-in select-all
		sendMessage(v.edit, emSetSel, 0, ^uintptr(0))
		return true
	}
	return false
}

// deleteWord handles Ctrl+Backspace, which the EDIT would otherwise insert as a box character.
func (v *View) deleteWord() {
	var start, end uint32
	_, _, _ = procSendMessageW.Call(v.edit, emGetSel, uintptr(unsafe.Pointer(&start)), uintptr(unsafe.Pointer(&end)))
	if start != end {
		v.replaceSelection("")
		return
	}
	from := wordStart(windowText(v.edit), int(end))
	sendMessage(v.edit, emSetSel, uintptr(from), uintptr(end))
	v.replaceSelection("")
}

func (v *View) replaceSelection(s string) {
	p, _ := windows.UTF16PtrFromString(s)
	_, _, _ = procSendMessageW.Call(v.edit, emReplaceSel, 1, uintptr(unsafe.Pointer(p)))
}

func (v *View) queryChanged() {
	if v.settingText || v.ev.Query == nil {
		return
	}
	v.ev.Query(string(utf16.Decode(windowText(v.edit))))
}

// dpiChanged handles the window moving to a monitor with a different DPI. Show sizes the window
// for its monitor before Windows reports the change. After a drag across monitors, the window
// keeps the position that Windows suggests and is resized for the new DPI.
func (v *View) dpiChanged(wp, lp uintptr) {
	dpi := lowWord(wp)
	if dpi == v.dpi { // Show already sized it for this monitor
		return
	}
	v.dpi = dpi
	v.g.discard()
	v.setFont()
	if !v.settingFrame {
		suggested := *(**rect)(unsafe.Pointer(&lp))
		v.left, v.top = suggested.Left, suggested.Top
		v.layout()
	}
	invalidate(v.hwnd, nil)
}

// waitMouse runs every 50 ms while a blur waits on the mouse (see WM_ACTIVATE), until blurDue
// allows the blur. It waits because a drag may end over the window, with the drop arriving
// afterwards. By then the window may have the foreground again, because a drop takes it, and then
// there is nothing to blur.
func (v *View) waitMouse() {
	down := mouseDown()
	if down {
		v.upAt = time.Time{}
	} else if v.upAt.IsZero() {
		v.upAt = time.Now()
	}
	if !blurDue(down, v.pointerOver(), time.Since(v.upAt)) {
		return
	}
	_, _, _ = procKillTimer.Call(v.hwnd, mouseTimer)
	if v.visible && foreground() != v.hwnd && v.ev.Blur != nil {
		v.ev.Blur()
	}
}

func (v *View) pointerOver() bool {
	p, r := cursorPos(), windowRect(v.hwnd)
	return p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom
}

func (v *View) moveStarted() { v.dragFrom = windowRect(v.hwnd) }

// moveEnded ignores a click that didn't move the window.
func (v *View) moveEnded() {
	r := windowRect(v.hwnd)
	if r == v.dragFrom || !v.visible {
		return
	}
	v.left, v.top = r.Left, r.Top
	if v.ev.Moved != nil {
		v.ev.Moved(view.Placement{Left: float64(r.Left), Top: float64(r.Top)})
	}
}

// panicked handles a panic recovered in a callback from Windows. A panic can't unwind through
// those callbacks, because the process would end, taking the core and every mount and transfer
// with it. Every panic is logged. If a frame was interrupted, its render target may be in the
// middle of drawing, so the target is discarded.
func panicked(where string, p any) {
	logger.Error("the launcher's window recovered from a panic", "in", where, "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
	if v := current; v != nil && v.g.drawing {
		v.g.drawing = false
		v.g.discard()
	}
}

func wndProc(hwnd, m, wp, lp uintptr) (r uintptr) {
	defer func() {
		if p := recover(); p != nil {
			panicked("the window's procedure", p)
			r = defWindowProc(hwnd, m, wp, lp) // as if the message weren't handled
		}
	}()
	v := current
	if v == nil || hwnd != v.hwnd {
		return defWindowProc(hwnd, m, wp, lp)
	}
	switch m {
	case wmNCCalcSize:
		if wp != 0 {
			return 0 // the client area is the whole window, so no frame shows
		}
	case wmNCHitTest:
		return v.hitTest(lp)
	case wmNCActivate:
		// -1 changes the activation without painting a frame, since there isn't one
		return defWindowProc(hwnd, m, wp, ^uintptr(0))
	case wmNCLButtonDbl:
		return 0 // double-clicking the "title bar" doesn't maximise
	case wmActivate:
		if lowWord(wp) == waInactive {
			switch {
			case !v.visible || v.ev.Blur == nil:
			case mouseDown():
				// A click elsewhere, or a drag starting there that may end here. The blur
				// waits for the button (see waitMouse).
				v.upAt = time.Time{}
				_, _, _ = procSetTimer.Call(hwnd, mouseTimer, 50, 0)
			default:
				v.ev.Blur()
			}
		} else {
			setFocus(v.edit)
		}
		return 0
	case wmSetFocus:
		setFocus(v.edit)
		return 0
	case wmSysCommand:
		if wp&0xFFF0 == scKeyMenu { // Alt alone, from forceForeground's tap; there is no menu to open
			return 0
		}
	case wmSettingChange:
		// "ImmersiveColorSet" means the app mode or the accent colour changed
		if lp != 0 && windows.UTF16PtrToString(*(**uint16)(unsafe.Pointer(&lp))) == "ImmersiveColorSet" {
			v.applyTheme()
		}
		return 0
	case wmClose: // Alt+F4 dismisses the launcher; the window lives as long as the app
		if v.ev.Key != nil {
			v.ev.Key(view.KeyEvent{Key: view.KeyClose})
		}
		return 0
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		var ps paintStruct
		_, _, _ = procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		v.paint(v.dips(ps.Paint))
		_, _, _ = procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		// Direct2D presents the whole client area, over the box. The box redraws itself on top
		// at once, so DWM never shows the window without it.
		redrawNow(v.edit)
		return 0
	case wmSize:
		v.g.resize(int32(lowWord(lp)), int32(highWord(lp)))
		return 0
	case wmDropFiles:
		paths := droppedFiles(wp)
		_, _, _ = procKillTimer.Call(hwnd, mouseTimer)
		if v.visible && len(paths) > 0 {
			forceForeground(hwnd)
			setFocus(v.edit)
			if v.ev.Drop != nil {
				v.ev.Drop(paths)
			}
		}
		return 0
	case wmTimer:
		switch wp {
		case mouseTimer:
			v.waitMouse()
		case handOffTimer: // the window didn't appear, so a window shown later isn't it
			v.stopAwaiting()
		case spinTimer:
			v.spin = (v.spin + 1) % spinDots
			v.invalidateBox(spinnerBox(v.snap))
		case swapTimer:
			if time.Since(v.swapStart) >= view.SwapFor {
				v.endSwap() // this frame, drawn at the end of the swap, is the last
			}
			v.invalidateBox(lineBox(v.snap))
		}
		return 0
	case wmCommand:
		if highWord(wp) == enChange && lp == v.edit {
			v.queryChanged()
		}
		return 0
	case wmCtlColorEdit:
		// draw the box on the query band, in the mode's text colour
		_, _, _ = procSetTextColor.Call(wp, uintptr(colorRef(v.pal.text)))
		_, _, _ = procSetBkColor.Call(wp, uintptr(colorRef(v.pal.surface)))
		return v.band
	case wmCtlColorStatic:
		// The live region's text is only for screen readers, so draw it in the band's colour.
		_, _, _ = procSetTextColor.Call(wp, uintptr(colorRef(v.pal.surface)))
		_, _, _ = procSetBkColor.Call(wp, uintptr(colorRef(v.pal.surface)))
		return v.band
	case wmMouseMove:
		v.mouseMoved(lp)
		return 0
	case wmMouseLeave:
		v.setStopHover(false)
		return 0
	case wmMouseWheel:
		v.scroll(wp)
		return 0
	case wmLButtonDown:
		if v.stopAtPixel(lparamX(lp), lparamY(lp)) {
			if v.ev.StopAll != nil {
				v.ev.StopAll()
			}
		} else if i := v.rowAtPixel(lparamY(lp)); i >= 0 && v.ev.Click != nil {
			v.ev.Click(i)
		}
		return 0
	case wmEnterSizeMove:
		v.moveStarted()
	case wmExitSizeMove:
		v.moveEnded()
	case wmDpiChanged:
		v.dpiChanged(wp, lp)
		return 0
	}
	return defWindowProc(hwnd, m, wp, lp)
}

func editProc(hwnd, m, wp, lp uintptr) (r uintptr) {
	defer func() {
		if p := recover(); p != nil {
			panicked("the query box's procedure", p)
			if v := current; v != nil && v.editProc != 0 { // fall back to the box's own handling
				r, _, _ = procCallWindowProcW.Call(v.editProc, hwnd, m, wp, lp)
			}
		}
	}()
	v := current
	if v == nil {
		return defWindowProc(hwnd, m, wp, lp)
	}
	switch m {
	case wmKeyDown:
		if v.key(wp) {
			peekChar(hwnd)
			return 0
		}
	case wmMouseWheel: // the box has keyboard focus, so wheel messages arrive here
		v.scroll(wp)
		return 0
	case wmChar:
		switch wp {
		case '\t', '\r', '\n', 0x1B: // keys the launcher handles; the box would beep
			return 0
		case 0x7F: // Ctrl+Backspace
			v.deleteWord()
			return 0
		}
	}
	r, _, _ = procCallWindowProcW.Call(v.editProc, hwnd, m, wp, lp)
	return r
}
