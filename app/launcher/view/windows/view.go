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
	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/i18n"
)

type View struct {
	ev view.Events
	g  *gfx

	hwnd, edit uintptr
	editProc   uintptr
	font       uintptr
	band       uintptr
	glass      bool
	dark       bool
	pal        palette
	live       *liveRegion
	dpi        uint32
	monDpi     uint32

	snap           view.Snapshot
	visible        bool
	left, top      int32
	prev           uintptr
	settingFrame   bool
	settingText    bool
	cursor         point
	wheel          int32
	dragFrom       rect
	spin           int
	ticking        bool
	stopHover      bool
	line, swapFrom view.Line
	swapStart      time.Time
	swapping       bool

	upAt     time.Time
	handOff  bool
	showHook uintptr
}

var current *View

var (
	wndProcCallback     = windows.NewCallback(wndProc)
	editProcCallback    = windows.NewCallback(editProc)
	windowShownCallback = windows.NewCallback(windowShown)
)

const (
	handOffTimer = 4
	handOffFor   = 5000
)

var logger = slog.Default()

func SetLog(l *slog.Logger) { logger = l }

const (
	className   = "RcuiLauncher"
	spinTimer   = 1
	mouseTimer  = 2
	swapTimer   = 3
	spinEvery   = 80
	swapEvery   = 16
	spinDots    = 8
	editID      = 1
	queryFontPt = 20.0
)

var transparent = colorF{}

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
	v.monDpi = windowDpi(hwnd)
	v.dpi = v.monDpi

	_ = dwmSet(hwnd, dwmwaWindowCornerPreference, dwmwcpRound)
	_ = dwmSet(hwnd, dwmwaTransitionsForceDisabled, 1)
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
	v.editProc, _, _ = procSetWindowLongPtrW.Call(v.edit, gwlpWndProc, editProcCallback)
	v.live = newLiveRegion(hwnd, instance)
	_, _, _ = procDragAcceptFiles.Call(hwnd, 1)
	v.setFont()
	v.layout()
	return nil
}

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

func (v *View) useMonitor(mon uintptr, monDpi uint32) {
	v.monDpi = monDpi
	var w, h int32
	if work, ok := workArea(mon); ok {
		w, h = work.width(), work.height()
	}
	v.dpi = drawDpi(monDpi, platform.TextScale(), w, h)
}

func (v *View) Show(at *view.Placement) {
	v.handOff = false
	v.stopAwaiting()
	was := v.dpi
	var mon uintptr
	if at != nil {
		mon = monitorAt(point{int32(at.Left) + 1, int32(at.Top) + 1}, monitorToNull)
	}
	if mon != 0 {
		v.left, v.top = int32(at.Left), int32(at.Top)
		v.useMonitor(mon, monitorDpi(mon))
	} else {
		mon = monitorAt(cursorPos(), monitorToNearest)
		v.useMonitor(mon, monitorDpi(mon))
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
	v.cursor = cursorPos()
	v.wheel = 0
	v.prev = foreground()
	v.layout()
	_, _, _ = procShowWindow.Call(v.hwnd, swShow)
	forceForeground(v.hwnd)
	setFocus(v.edit)
	v.tick()
}

func forceForeground(hwnd uintptr) {
	if setForeground(hwnd) && foreground() == hwnd {
		return
	}
	keyTap(vkMenu, 0)
	ok := setForeground(hwnd)
	keyTap(vkMenu, keyeventfKeyUp)
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

func HandOff() {
	if v := current; v != nil && v.visible {
		v.handOff = true
	}
}

func (v *View) Hide() {
	ours := foreground() == v.hwnd
	handOff := v.handOff
	v.handOff = false
	v.visible = false
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

func spinnerBox(s view.Snapshot) rectF {
	top := float32(view.FooterTop(s)) + 1
	return rectF{Left: 18, Top: top, Right: 18 + view.SpinSize, Bottom: top + view.SpinSize}
}

func lineBox(s view.Snapshot) rectF {
	top := float32(view.FooterTop(s))
	return rectF{Left: 18, Top: top - view.Slide, Right: 18 + view.FooterW, Bottom: top + 18 + view.Slide}
}

func stopBox(s view.Snapshot) rectF {
	top := float32(view.StopTop(s))
	return rectF{Left: view.StopLeft, Top: top, Right: view.StopLeft + view.StopSize, Bottom: top + view.StopSize}
}

func (v *View) invalidateBox(r rectF) {
	s := v.scale()
	pr := rect{px(float64(r.Left), s) - 2, px(float64(r.Top), s) - 2, px(float64(r.Right), s) + 2, px(float64(r.Bottom), s) + 2}
	invalidate(v.hwnd, &pr)
}

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

func (v *View) dips(r rect) rectF {
	s := float32(v.scale())
	return rectF{float32(r.Left) / s, float32(r.Top) / s, float32(r.Right) / s, float32(r.Bottom) / s}
}

func overlaps(a, b rectF) bool {
	return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom
}

func covers(a, b rectF) bool {
	return a.Left <= b.Left && a.Top <= b.Top && a.Right >= b.Right && a.Bottom >= b.Bottom
}

func (v *View) paintList(list, dirty rectF) {
	s, g := v.snap, v.g
	g.clip(list)
	defer g.unclip()
	for i, r := range s.Rows {
		y := float32(view.RowTop(s, i))
		top := y
		if r.Group != "" {
			top -= view.GroupH
		}
		if top >= min(list.Bottom, dirty.Bottom) {
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

func (v *View) paintFooter() {
	if v.swapping {
		e := swapProgress(time.Since(v.swapStart))
		v.paintLine(v.swapFrom, -view.Slide*e, 1-e)
		v.paintLine(v.line, view.Slide*(1-e), e)
	} else {
		v.paintLine(v.line, 0, 1)
	}
}

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

func (v *View) rowAtPixel(y int32) int {
	return view.RowAt(float64(y)/v.scale(), v.snap)
}

func (v *View) stopAtPixel(x, y int32) bool {
	s := v.scale()
	return view.InStop(float64(x)/s, float64(y)/s, v.snap)
}

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
		v.ev.Scroll(int(-n))
	}
}

func (v *View) hitTest(lp uintptr) uintptr {
	r := windowRect(v.hwnd)
	x, y := lparamX(lp)-r.Left, lparamY(lp)-r.Top
	if v.rowAtPixel(y) >= 0 || v.stopAtPixel(x, y) {
		return htClient
	}
	return htCaption
}

func (v *View) key(vk uintptr) bool {
	ctrl, shift, alt := keyDown(vkControl), keyDown(vkShift), keyDown(vkMenu)
	k, ok := keyFor(uint32(vk), ctrl, shift, alt)
	if ok && v.ev.Key != nil && v.ev.Key(k) {
		return true
	}
	if ctrl && !alt && vk == 'A' {
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

func (v *View) dpiChanged(wp, lp uintptr) {
	dpi := lowWord(wp)
	if dpi == v.monDpi {
		return
	}
	suggested := *(**rect)(unsafe.Pointer(&lp))
	v.useMonitor(monitorAt(point{suggested.Left + 1, suggested.Top + 1}, monitorToNearest), dpi)
	v.g.discard()
	v.setFont()
	if !v.settingFrame {
		v.left, v.top = suggested.Left, suggested.Top
		v.layout()
	}
	invalidate(v.hwnd, nil)
}

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
			r = defWindowProc(hwnd, m, wp, lp)
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
		return 0
	case wmActivate:
		if lowWord(wp) == waInactive {
			switch {
			case !v.visible || v.ev.Blur == nil:
			case mouseDown():
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
		if wp&0xFFF0 == scKeyMenu {
			return 0
		}
	case wmSettingChange:
		if lp != 0 && windows.UTF16PtrToString(*(**uint16)(unsafe.Pointer(&lp))) == "ImmersiveColorSet" {
			v.applyTheme()
		}
		return 0
	case wmClose:
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
		case handOffTimer:
			v.stopAwaiting()
		case spinTimer:
			v.spin = (v.spin + 1) % spinDots
			v.invalidateBox(spinnerBox(v.snap))
		case swapTimer:
			if time.Since(v.swapStart) >= view.SwapFor {
				v.endSwap()
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
		_, _, _ = procSetTextColor.Call(wp, uintptr(colorRef(v.pal.text)))
		_, _, _ = procSetBkColor.Call(wp, uintptr(colorRef(v.pal.surface)))
		return v.band
	case wmCtlColorStatic:
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
			if v := current; v != nil && v.editProc != 0 {
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
	case wmMouseWheel:
		v.scroll(wp)
		return 0
	case wmChar:
		switch wp {
		case '\t', '\r', '\n', 0x1B: // keys the launcher handles; the box would beep
			return 0
		case 0x7F:
			v.deleteWord()
			return 0
		}
	}
	r, _, _ = procCallWindowProcW.Call(v.editProc, hwnd, m, wp, lp)
	return r
}
