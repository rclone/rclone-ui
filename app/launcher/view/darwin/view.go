//go:build darwin

// Package darwin is the launcher window on macOS, written in Go on top of Cocoa. The window is a
// non-activating panel, so it can take keyboard focus without activating the app, which macOS
// may refuse to do. It uses Liquid Glass on macOS 26 and an always-active blur on earlier versions.
package darwin

import (
	"errors"
	"strings"

	"github.com/ebitengine/purego/objc"

	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/view"
	"github.com/rclone/rclone-ui/core/i18n"
)

// View is the launcher panel. There is one per process, and Cocoa callbacks find it through
// current.
type View struct {
	ev view.Events

	panel, content, field, header objc.ID
	// list holds the rows and their group labels, and clips them at its bottom edge, so the last
	// row of a long list is drawn only in part.
	list        objc.ID
	groupLabels []objc.ID // one label per row, shown above the row when it starts a group
	rows        []row
	icons       map[icons.Name]objc.ID
	// footer holds the footer line, which shows the hints or a status. It has two slots.
	// slots[active] holds the line shown now, and the other slot holds the line it replaced
	// (see view.Swaps).
	footer    objc.ID
	slots     [2]slot
	active    int
	line      view.Line
	stop      objc.ID
	stopHover bool
	// language is the language that the panel's own labels were last set in (see label).
	language string

	snap           view.Snapshot
	visible        bool
	left, top      float64      // the top-left corner, in screen points
	settingFrame   bool         // set while the view moves the panel, so the move isn't reported
	hoverX, hoverY float64      // the last known pointer position, in screen points
	scrolled       float64      // the fraction of a row scrolled but not yet reported
	blocks         []objc.Block // kept for the life of the process
	// When the panel loses keyboard focus while a mouse button is down, the cause may be a click
	// elsewhere or a drag starting there. The panel then waits for the button to be released
	// before reporting the blur, so the drag can still be dropped on it. dragOver is set while a
	// drag is over the panel, and waitTimer checks the buttons while the panel waits.
	dragOver  bool
	waitTimer objc.ID
	waitTick  objc.Block
}

type row struct {
	box, icon, title, sub, tail, hint objc.ID
}

type slot struct {
	box, spinner, label objc.ID
}

var current *View

// guard runs the Go side of a Cocoa callback. A panic can't unwind through the Objective-C frames
// that called it, because the process would abort, taking the core with it. So guard recovers the
// panic, reports it through Events.Panicked, and the launcher keeps running.
func guard(where string, fn func()) {
	defer recovered(where)
	fn()
}

// guarded is guard for a callback that returns a value. It returns otherwise after a panic.
func guarded[T any](where string, otherwise T, fn func() T) (out T) {
	out = otherwise
	defer recovered(where)
	return fn()
}

// recovered must be deferred.
func recovered(where string) {
	if v := recover(); v != nil && current != nil && current.ev.Panicked != nil {
		current.ev.Panicked("launcher view: "+where, v)
	}
}

var (
	panelClass, contentClass, hoverClass, stopClass objc.Class
)

// New builds the panel, hidden. It must be called once, on the main thread.
func New(ev view.Events) (*View, error) {
	if current != nil {
		return nil, errors.New("the launcher's window exists already")
	}
	if err := registerClasses(); err != nil {
		return nil, err
	}
	v := &View{ev: ev, icons: map[icons.Name]objc.ID{}}
	current = v
	v.build()
	return v, nil
}

func registerClasses() error {
	var err error
	panelClass, err = objc.RegisterClass("RcuiLauncherPanel", objc.GetClass("NSPanel"), nil, nil, []objc.MethodDef{
		{Cmd: sel("canBecomeKeyWindow"), Fn: func(objc.ID, objc.SEL) bool { return true }},
		{Cmd: sel("canBecomeMainWindow"), Fn: func(objc.ID, objc.SEL) bool { return false }},
	})
	if err != nil {
		return err
	}
	contentClass, err = objc.RegisterClass("RcuiLauncherContent", objc.GetClass("NSView"), nil, nil, []objc.MethodDef{
		{Cmd: sel("isFlipped"), Fn: func(objc.ID, objc.SEL) bool { return true }},
		{Cmd: sel("acceptsFirstMouse:"), Fn: func(objc.ID, objc.SEL, objc.ID) bool { return true }},
		{Cmd: sel("mouseDown:"), Fn: func(_ objc.ID, _ objc.SEL, e objc.ID) { guard("mouseDown", func() { current.mouseDown(e) }) }},
		{Cmd: sel("scrollWheel:"), Fn: func(_ objc.ID, _ objc.SEL, e objc.ID) { guard("scrollWheel", func() { current.scrollWheel(e) }) }},
		// NSDraggingDestination, for files dragged onto the panel.
		{Cmd: sel("draggingEntered:"), Fn: func(objc.ID, objc.SEL, objc.ID) uint {
			return guarded("draggingEntered", dragNone, func() uint { return current.dragEntered() })
		}},
		{Cmd: sel("draggingUpdated:"), Fn: func(objc.ID, objc.SEL, objc.ID) uint { return dragCopy }},
		{Cmd: sel("draggingExited:"), Fn: func(objc.ID, objc.SEL, objc.ID) { guard("draggingExited", func() { current.dragOver = false }) }},
		{Cmd: sel("prepareForDragOperation:"), Fn: func(objc.ID, objc.SEL, objc.ID) bool { return true }},
		{Cmd: sel("performDragOperation:"), Fn: func(_ objc.ID, _ objc.SEL, info objc.ID) bool {
			return guarded("performDragOperation", false, func() bool { return current.drop(info) })
		}},
	})
	if err != nil {
		return err
	}
	hoverClass, err = objc.RegisterClass("RcuiLauncherHover", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
		{Cmd: sel("mouseMoved:"), Fn: func(_ objc.ID, _ objc.SEL, e objc.ID) { guard("mouseMoved", func() { current.mouseMoved(e) }) }},
		{Cmd: sel("mouseEntered:"), Fn: func(objc.ID, objc.SEL, objc.ID) {}},
		{Cmd: sel("mouseExited:"), Fn: func(objc.ID, objc.SEL, objc.ID) { guard("mouseExited", func() { current.stopLook(false) }) }},
	})
	if err != nil {
		return err
	}
	stopClass, err = objc.RegisterClass("RcuiLauncherStop", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
		{Cmd: sel("stopAll:"), Fn: func(objc.ID, objc.SEL, objc.ID) {
			guard("stopAll", func() {
				if current.ev.StopAll != nil {
					current.ev.StopAll()
				}
			})
		}},
	})
	return err
}

func (v *View) build() {
	full := view.FullHeight() + view.HeaderH
	// The panel is titled rather than borderless. A transparent borderless window gets its shadow
	// from a surface drawn afterwards, which has square edges and flashes. A hidden full-size
	// title bar keeps the panel frameless and lets AppKit draw the rounded outline and shadow.
	const titled, nonactivating, fullSize = 1, 1 << 7, 1 << 15
	v.panel = msg(objc.ID(panelClass).Send(sel("alloc")), "initWithContentRect:styleMask:backing:defer:",
		rect(0, 0, view.Width, full), uint(titled|nonactivating|fullSize), uint(2), false)
	msg(v.panel, "setTitlebarAppearsTransparent:", true)
	msg(v.panel, "setTitleVisibility:", 1)
	for b := range uint(3) { // close, minimise, zoom
		msg(msg(v.panel, "standardWindowButton:", b), "setHidden:", true)
	}
	msg(v.panel, "setLevel:", 3)                         // floating
	msg(v.panel, "setCollectionBehavior:", uint(1|1<<8)) // every Space, over full-screen apps
	msg(v.panel, "setFloatingPanel:", true)
	msg(v.panel, "setBecomesKeyOnlyIfNeeded:", false)
	msg(v.panel, "setHidesOnDeactivate:", false)
	msg(v.panel, "setReleasedWhenClosed:", false)
	msg(v.panel, "setMovableByWindowBackground:", false)
	msg(v.panel, "setOpaque:", false)
	msg(v.panel, "setBackgroundColor:", color("clearColor"))
	msg(v.panel, "setHasShadow:", true)

	// The content goes inside the glass, because only there does AppKit apply the glass's
	// legibility treatment.
	v.content = msg(objc.ID(contentClass).Send(sel("alloc")), "initWithFrame:", rect(0, 0, view.Width, full))
	msg(v.content, "setAutoresizingMask:", uint(2|16)) // width, height
	if g := class("NSGlassEffectView"); g != 0 {
		glass := msg(msg(g, "alloc"), "initWithFrame:", rect(0, 0, view.Width, full))
		msg(glass, "setCornerRadius:", view.Radius)
		msg(glass, "setWantsLayer:", true)
		msg(msg(glass, "layer"), "setCornerRadius:", view.Radius)
		msg(msg(glass, "layer"), "setMasksToBounds:", true)
		msg(glass, "setContentView:", v.content)
		msg(v.panel, "setContentView:", glass)
	} else {
		fx := msg(alloc("NSVisualEffectView"), "initWithFrame:", rect(0, 0, view.Width, full))
		msg(fx, "setMaterial:", 6)     // popover
		msg(fx, "setState:", 1)        // always active
		msg(fx, "setBlendingMode:", 0) // behind the window
		msg(fx, "setWantsLayer:", true)
		msg(msg(fx, "layer"), "setCornerRadius:", view.Radius)
		msg(msg(fx, "layer"), "setMasksToBounds:", true)
		msg(fx, "addSubview:", v.content)
		msg(v.panel, "setContentView:", fx)
	}

	v.field = msg(alloc("NSTextField"), "initWithFrame:", rect(18, view.FieldTop, view.FieldW, 30))
	msg(v.field, "setBezeled:", false)
	msg(v.field, "setBordered:", false)
	msg(v.field, "setDrawsBackground:", false)
	msg(v.field, "setFocusRingType:", 1) // none
	msg(v.field, "setFont:", font(22, false))
	msg(v.field, "setAutoresizingMask:", uint(2))
	msg(v.content, "addSubview:", v.field)

	v.buildStop()

	v.header = label(12)
	msg(v.header, "setTextColor:", color("secondaryLabelColor"))
	msg(v.header, "setFrame:", rect(18, view.QueryH, view.Width-36, 16))
	msg(v.content, "addSubview:", v.header)

	v.list = msg(objc.ID(contentClass).Send(sel("alloc")), "initWithFrame:", rect(0, view.QueryH, view.Width, view.MaxListH))
	msg(v.list, "setWantsLayer:", true)
	msg(msg(v.list, "layer"), "setMasksToBounds:", true)
	if msgBool(v.list, "respondsToSelector:", sel("setClipsToBounds:")) {
		msg(v.list, "setClipsToBounds:", true)
	}
	msg(v.content, "addSubview:", v.list)
	for range view.MaxRows {
		sec := label(11)
		msg(sec, "setFont:", msg(class("NSFont"), "systemFontOfSize:weight:", 11.0, 0.3)) // semibold
		msg(sec, "setTextColor:", color("secondaryLabelColor"))
		msg(sec, "setHidden:", true)
		msg(v.list, "addSubview:", sec)
		v.groupLabels = append(v.groupLabels, sec)
		r := row{box: msg(objc.ID(contentClass).Send(sel("alloc")), "initWithFrame:", rect(view.Padding, 0, view.Width-2*view.Padding, view.RowH-4))}
		msg(r.box, "setWantsLayer:", true)
		msg(msg(r.box, "layer"), "setCornerRadius:", 10.0)
		r.icon = msg(alloc("NSImageView"), "initWithFrame:", rect(14, (view.RowH-4-view.IconSize)/2, view.IconSize, view.IconSize))
		r.title = label(15)
		r.sub = label(12)
		r.tail = label(12)
		msg(r.tail, "setAlignment:", 2) // right
		r.hint = label(12)
		msg(r.hint, "setAlignment:", 2)
		inner := view.Width - 2*view.Padding
		msg(r.title, "setFrame:", rect(46, 4, inner-46-250, 20))
		msg(r.sub, "setFrame:", rect(46, 24, inner-46-250, 16))
		msg(r.tail, "setFrame:", rect(inner-250, (view.RowH-4-16)/2, 180, 16))
		msg(r.hint, "setFrame:", rect(inner-64, (view.RowH-4-16)/2, 50, 16))
		for _, sub := range []objc.ID{r.icon, r.title, r.sub, r.tail, r.hint} {
			msg(r.box, "addSubview:", sub)
		}
		msg(r.box, "setHidden:", true)
		msg(v.list, "addSubview:", r.box)
		v.rows = append(v.rows, r)
	}
	v.buildFooter()

	// Hover uses a tracking area, which works whether or not the panel is the key window.
	hover := msg(objc.ID(hoverClass).Send(sel("alloc")), "init")
	const moved, enteredExited, always, inVisibleRect = 0x02, 0x01, 0x80, 0x200
	area := msg(alloc("NSTrackingArea"), "initWithRect:options:owner:userInfo:", nsRect{},
		uint(moved|enteredExited|always|inVisibleRect), hover, objc.ID(0))
	msg(v.content, "addTrackingArea:", area)

	// The launcher sees keys before the text field does. Keys it doesn't handle, such as typing,
	// go on to the field.
	keys := objc.NewBlock(func(_ objc.Block, e objc.ID) objc.ID {
		return guarded("key", e, func() objc.ID {
			if msg(e, "window") != v.panel {
				return e
			}
			if v.key(e) {
				return 0
			}
			return e
		})
	})
	msg(class("NSEvent"), "addLocalMonitorForEventsMatchingMask:handler:", uint64(1<<10), keys)

	center := msg(class("NSNotificationCenter"), "defaultCenter")
	observe := func(name string, object objc.ID, fn func()) {
		b := objc.NewBlock(func(_ objc.Block, _ objc.ID) { guard(name, fn) })
		msg(center, "addObserverForName:object:queue:usingBlock:", nsString(name), object, objc.ID(0), b)
		v.blocks = append(v.blocks, b)
	}
	observe("NSControlTextDidChangeNotification", v.field, func() {
		if v.ev.Query != nil {
			v.ev.Query(goString(msg(v.field, "stringValue")))
		}
	})
	observe("NSWindowDidResignKeyNotification", v.panel, v.resigned)
	msg(v.content, "registerForDraggedTypes:", msg(class("NSArray"), "arrayWithObject:", nsString("public.file-url")))
	v.waitTick = objc.NewBlock(func(_ objc.Block, _ objc.ID) { guard("checkButtons", v.checkButtons) })
	observe("NSWindowDidMoveNotification", v.panel, v.moved)
	v.blocks = append(v.blocks, keys)
}

// buildFooter builds the footer line: two slots in a box that is Slide taller above and below,
// so a line that moves in or out stays inside it.
func (v *View) buildFooter() {
	v.footer = msg(objc.ID(contentClass).Send(sel("alloc")), "initWithFrame:", rect(18, 0, view.FooterW, 18+2*view.Slide))
	msg(v.content, "addSubview:", v.footer)
	for i := range v.slots {
		sl := slot{box: msg(objc.ID(contentClass).Send(sel("alloc")), "initWithFrame:", rect(0, view.Slide, view.FooterW, 18))}
		msg(sl.box, "setWantsLayer:", true)
		sl.spinner = msg(alloc("NSProgressIndicator"), "initWithFrame:", rect(0, 1, view.SpinSize, view.SpinSize))
		msg(sl.spinner, "setStyle:", 1)       // spinning
		msg(sl.spinner, "setControlSize:", 1) // small
		msg(sl.spinner, "setDisplayedWhenStopped:", false)
		sl.label = label(12)
		msg(sl.box, "addSubview:", sl.spinner)
		msg(sl.box, "addSubview:", sl.label)
		msg(v.footer, "addSubview:", sl.box)
		if i != v.active {
			msg(sl.box, "setAlphaValue:", 0.0)
		}
		v.slots[i] = sl
	}
	v.fill(v.slots[v.active], v.line)
}

// fill puts line in sl. A status is also set as the tooltip, because its text may be cut off.
func (v *View) fill(sl slot, line view.Line) {
	text, col, left := line.Hints, color("secondaryLabelColor"), 0.0
	switch line.Status.Kind {
	case view.StatusLoading:
		text, left = line.Status.Text, view.StatusLeft-18
	case view.StatusDone:
		text, col = line.Status.Text, color("systemGreenColor")
	case view.StatusError:
		text, col = line.Status.Text, color("systemRedColor")
	}
	if left > 0 {
		msg(sl.spinner, "startAnimation:", objc.ID(0))
	} else {
		msg(sl.spinner, "stopAnimation:", objc.ID(0))
	}
	msg(sl.label, "setFrame:", rect(left, 0, view.FooterW-left, 18))
	msg(sl.label, "setStringValue:", nsString(text))
	msg(sl.label, "setTextColor:", col)
	tip := ""
	if line.Status.Kind != view.StatusNone {
		tip = text
	}
	msg(sl.label, "setToolTip:", nsString(tip))
}

// showLine shows the footer line for s. When view.Swaps allows it, the old line moves up and out
// while the new one moves up from below.
func (v *View) showLine(s view.Snapshot) {
	line := view.FooterLine(s)
	switch {
	case line == v.line:
		return
	case !view.Swaps(v.line, line):
		v.fill(v.slots[v.active], line)
		v.line = line
		return
	}
	v.line = line
	out, in := v.slots[v.active], v.slots[1-v.active]
	v.active = 1 - v.active
	v.fill(in, line)
	msg(in.box, "setAlphaValue:", 0.0)
	msg(in.box, "setFrameOrigin:", nsPoint{0, 2 * view.Slide})
	animations := class("NSAnimationContext")
	msg(animations, "beginGrouping")
	ctx := msg(animations, "currentContext")
	msg(ctx, "setDuration:", view.SwapFor.Seconds())
	msg(ctx, "setTimingFunction:", msg(class("CAMediaTimingFunction"), "functionWithName:", nsString("easeOut")))
	msg(msg(out.box, "animator"), "setAlphaValue:", 0.0)
	msg(msg(out.box, "animator"), "setFrameOrigin:", nsPoint{0, 0})
	msg(msg(in.box, "animator"), "setAlphaValue:", 1.0)
	msg(msg(in.box, "animator"), "setFrameOrigin:", nsPoint{0, view.Slide})
	msg(animations, "endGrouping")
}

func (v *View) buildStop() {
	v.stop = msg(alloc("NSButton"), "initWithFrame:", rect(view.StopLeft, 0, view.StopSize, view.StopSize))
	msg(v.stop, "setBordered:", false)
	msg(v.stop, "setTitle:", nsString(""))
	msg(v.stop, "setImagePosition:", uint(1)) // image only
	if img := v.icon(icons.StopAll); img != 0 {
		small := msg(img, "copy")
		msg(small, "setSize:", nsSize{14, 14})
		msg(v.stop, "setImage:", small)
	}
	msg(v.stop, "setWantsLayer:", true)
	msg(msg(v.stop, "layer"), "setCornerRadius:", view.StopSize/2)
	msg(v.stop, "setTarget:", msg(objc.ID(stopClass).Send(sel("alloc")), "init"))
	msg(v.stop, "setAction:", sel("stopAll:"))
	v.stopLook(false)
	msg(v.content, "addSubview:", v.stop)
}

func (v *View) stopLook(hover bool) {
	if v.stop == 0 {
		return
	}
	v.stopHover = hover
	tint, disc, alpha := color("secondaryLabelColor"), color("labelColor"), 0.07
	if v.snap.Running {
		tint, disc, alpha = color("systemRedColor"), color("systemRedColor"), 0.16
	}
	if hover {
		alpha *= 2
	}
	msg(v.stop, "setContentTintColor:", tint)
	msg(msg(v.stop, "layer"), "setBackgroundColor:", msg(msg(disc, "colorWithAlphaComponent:", alpha), "CGColor"))
}

func (v *View) Show(at *view.Placement) {
	screens := msg(class("NSScreen"), "screens")
	if at != nil && onScreen(screens, at.Left+view.Width/2, at.Top-view.QueryH/2) {
		v.left, v.top = at.Left, at.Top
	} else {
		vf := mouseScreen(screens)
		dx, dy := view.Centred(vf.Size.W, vf.Size.H, 1)
		v.left = vf.Origin.X + dx
		v.top = vf.Origin.Y + vf.Size.H - dy // AppKit's y grows upward
	}
	v.visible = true
	// Record the current pointer position, so rows appearing under it don't count as a move and
	// don't change the selection.
	m := msgPoint(class("NSEvent"), "mouseLocation")
	v.hoverX, v.hoverY = m.X, m.Y
	v.scrolled = 0
	v.layout()
	msg(v.panel, "makeKeyAndOrderFront:", objc.ID(0))
	msg(v.panel, "makeFirstResponder:", v.field)
}

func (v *View) Hide() {
	v.visible = false
	v.stopWaiting()
	msg(v.panel, "orderOut:", objc.ID(0))
}

// resigned handles the panel losing keyboard focus. It reports the blur at once, unless a mouse
// button is down (see View.dragOver).
func (v *View) resigned() {
	if !v.visible || v.ev.Blur == nil {
		return
	}
	if objc.Send[uint](class("NSEvent"), sel("pressedMouseButtons")) == 0 {
		v.ev.Blur()
		return
	}
	if v.waitTimer == 0 {
		v.waitTimer = msg(class("NSTimer"), "timerWithTimeInterval:repeats:block:", 0.05, true, v.waitTick)
		// Use the common modes so the timer also runs during a drag session's tracking loop.
		msg(msg(class("NSRunLoop"), "mainRunLoop"), "addTimer:forMode:", v.waitTimer, nsString("kCFRunLoopCommonModes"))
	}
}

// checkButtons reports the blur that waited, unless a drop gave the panel focus again.
func (v *View) checkButtons() {
	if v.dragOver || objc.Send[uint](class("NSEvent"), sel("pressedMouseButtons")) != 0 {
		return
	}
	v.stopWaiting()
	if v.visible && !msgBool(v.panel, "isKeyWindow") && v.ev.Blur != nil {
		v.ev.Blur()
	}
}

func (v *View) stopWaiting() {
	if v.waitTimer != 0 {
		msg(v.waitTimer, "invalidate")
		v.waitTimer = 0
	}
	v.dragOver = false
}

// dragCopy is NSDragOperationCopy. Dropped files are copied or moved, depending on what the user
// then picks. dragNone is NSDragOperationNone, which refuses them.
const (
	dragCopy = 1
	dragNone = 0
)

func (v *View) dragEntered() uint {
	v.dragOver = true
	return dragCopy
}

func (v *View) drop(info objc.ID) bool {
	v.dragOver = false
	urls := msg(msg(info, "draggingPasteboard"), "readObjectsForClasses:options:",
		msg(class("NSArray"), "arrayWithObject:", class("NSURL")), objc.ID(0))
	var paths []string
	for i := uint(0); urls != 0 && i < objc.Send[uint](urls, sel("count")); i++ {
		if u := msg(urls, "objectAtIndex:", i); msgBool(u, "isFileURL") {
			paths = append(paths, goString(msg(u, "path")))
		}
	}
	if len(paths) == 0 {
		return false
	}
	v.stopWaiting()
	msg(v.panel, "makeKeyAndOrderFront:", objc.ID(0))
	msg(v.panel, "makeFirstResponder:", v.field)
	if v.ev.Drop != nil {
		v.ev.Drop(paths)
	}
	return true
}

func (v *View) Visible() bool { return v.visible }

func (v *View) SetQuery(text string, selectAll bool) {
	msg(v.field, "setStringValue:", nsString(text))
	if selectAll {
		msg(v.field, "selectText:", objc.ID(0))
		return
	}
	if ed := msg(v.field, "currentEditor"); ed != 0 {
		n := objc.Send[uint](msg(v.field, "stringValue"), sel("length"))
		msg(ed, "setSelectedRange:", nsRange{n, 0})
	}
}

// label translates the view's own labels. Render calls it, so they follow a change of language.
// The panel's title doesn't show, but VoiceOver reads it.
func (v *View) label() {
	if lang := i18n.Language(); lang != v.language {
		v.language = lang
		msg(v.panel, "setTitle:", nsString(i18n.T("Launcher")))
		msg(v.stop, "setToolTip:", nsString(i18n.T("Stop everything (⌘.)")))
		msg(v.stop, "setAccessibilityLabel:", nsString(i18n.T("Stop everything")))
	}
}

func (v *View) Render(s view.Snapshot) {
	v.snap = s
	v.label()
	msg(v.field, "setPlaceholderString:", nsString(s.Placeholder))
	v.stopLook(v.stopHover)
	msg(v.header, "setHidden:", s.Header == "")
	msg(v.header, "setStringValue:", nsString(s.Header))
	top := view.RowsTop(s.Header != "")
	for i, r := range v.rows {
		sec := v.groupLabels[i]
		if i >= len(s.Rows) {
			msg(r.box, "setHidden:", true)
			msg(sec, "setHidden:", true)
			continue
		}
		y := view.RowTop(s, i) - top // relative to the list
		x := s.Rows[i]
		msg(sec, "setHidden:", x.Group == "")
		if x.Group != "" {
			msg(sec, "setStringValue:", nsString(x.Group))
			msg(sec, "setFrame:", rect(18, y-view.GroupH+5, view.Width-36, 16))
		}
		v.drawRow(r, x, i == s.Selected, y)
	}
	v.showLine(s)
	v.layout()
}

func (v *View) drawRow(r row, x view.Row, selected bool, y float64) {
	msg(r.box, "setHidden:", false)
	msg(r.box, "setFrame:", rect(view.Padding, y, view.Width-2*view.Padding, view.RowH-4))
	text, sub, icon := color("labelColor"), color("secondaryLabelColor"), color("labelColor")
	if x.Danger {
		icon = color("systemRedColor")
	}
	bg := objc.ID(0)
	if selected {
		text, sub = color("whiteColor"), msg(color("whiteColor"), "colorWithAlphaComponent:", 0.8)
		icon = text
		bg = msg(color("controlAccentColor"), "CGColor")
		if x.Danger {
			bg = msg(color("systemRedColor"), "CGColor")
		}
	}
	msg(msg(r.box, "layer"), "setBackgroundColor:", bg)
	as := attributed(x.Title, 15, text, x.Bold)
	msg(r.title, "setAttributedStringValue:", as)
	msg(as, "release")
	inner := view.Width - 2*view.Padding
	if x.Subtitle == "" {
		msg(r.title, "setFrame:", rect(46, (view.RowH-4-20)/2, inner-46-250, 20))
	} else {
		msg(r.title, "setFrame:", rect(46, 4, inner-46-250, 20))
	}
	msg(r.sub, "setStringValue:", nsString(x.Subtitle))
	msg(r.sub, "setTextColor:", sub)
	msg(r.tail, "setStringValue:", nsString(x.Tail))
	msg(r.tail, "setTextColor:", sub)
	msg(r.hint, "setStringValue:", nsString(x.Hint))
	msg(r.hint, "setTextColor:", sub)
	msg(r.icon, "setImage:", v.icon(x.Icon))
	msg(r.icon, "setContentTintColor:", icon)
}

func (v *View) icon(n icons.Name) objc.ID {
	if img, ok := v.icons[n]; ok {
		return img
	}
	var img objc.ID
	if svg := icons.SVG(n); svg != "" {
		img = msg(alloc("NSImage"), "initWithData:", nsData([]byte(svg)))
		if img != 0 {
			msg(img, "setTemplate:", true)
			msg(img, "setSize:", nsSize{view.IconSize, view.IconSize})
		}
	}
	v.icons[n] = img
	return img
}

func (v *View) layout() {
	s := v.snap
	h := view.Height(s)
	msg(v.list, "setFrame:", rect(0, view.RowsTop(s.Header != ""), view.Width, view.ListH(s)))
	foot := view.FooterTop(s)
	msg(v.footer, "setFrameOrigin:", nsPoint{18, foot - view.Slide})
	msg(v.stop, "setFrame:", rect(view.StopLeft, view.StopTop(s), view.StopSize, view.StopSize))
	v.settingFrame = true
	if v.visible {
		msg(v.panel, "setFrame:display:", rect(v.left, v.top-h, view.Width, h), true)
		msg(v.panel, "invalidateShadow")
	} else {
		f := msgRect(v.panel, "frame")
		msg(v.panel, "setFrame:display:", rect(f.Origin.X, f.Origin.Y+f.Size.H-h, view.Width, h), false)
	}
	v.settingFrame = false
}

func (v *View) moved() {
	if !v.visible || v.settingFrame {
		return
	}
	f := msgRect(v.panel, "frame")
	v.left, v.top = f.Origin.X, f.Origin.Y+f.Size.H
	if v.ev.Moved != nil {
		v.ev.Moved(view.Placement{Left: v.left, Top: v.top})
	}
}

// key returns false to leave the key to the text field. While an input method such as Pinyin or
// Kotoeri is composing, every key goes to the field: Enter commits the candidate, the arrows and
// Tab choose one, and Esc cancels.
func (v *View) key(e objc.ID) bool {
	if v.ev.Key == nil {
		return false
	}
	if ed := msg(v.field, "currentEditor"); ed != 0 && msgBool(ed, "hasMarkedText") {
		return false
	}
	code := objc.Send[uint16](e, sel("keyCode"))
	flags := objc.Send[uint](e, sel("modifierFlags"))
	cmd := flags&(1<<20) != 0
	k := view.KeyEvent{}
	switch {
	case code == 53:
		k.Key = view.KeyEsc
	case code == 36 || code == 76:
		k.Key = view.KeyEnter
	case code == 125:
		k.Key = view.KeyDown
	case code == 126:
		k.Key = view.KeyUp
	case code == 48 && flags&(1<<17) == 0: // tab, not shift-tab
		k.Key = view.KeyTab
	case cmd:
		chars := []rune(strings.ToLower(goString(msg(e, "charactersIgnoringModifiers"))))
		if len(chars) != 1 {
			return false
		}
		if chars[0] == 'k' {
			k.Key = view.KeyActions
		} else {
			k.Key, k.Char = view.KeyRow, chars[0]
		}
	default:
		return false
	}
	return v.ev.Key(k)
}

func (v *View) mouseMoved(e objc.ID) {
	if !v.visible {
		return
	}
	if !msgBool(v.panel, "isKeyWindow") {
		msg(v.panel, "makeKeyAndOrderFront:", objc.ID(0))
	}
	// Only real mouse movement selects a row, so compare screen coordinates. The panel appearing,
	// or rows shifting under a still pointer, doesn't move the selection.
	m := msgPoint(class("NSEvent"), "mouseLocation")
	if m.X == v.hoverX && m.Y == v.hoverY {
		return
	}
	v.hoverX, v.hoverY = m.X, m.Y
	p := msgPoint(v.content, "convertPoint:fromView:", msgPoint(e, "locationInWindow"), objc.ID(0))
	if on := view.InStop(p.X, p.Y, v.snap); on != v.stopHover {
		v.stopLook(on)
	}
	if i := v.rowAt(p.Y); i >= 0 && v.ev.Hover != nil {
		v.ev.Hover(i)
	}
}

func (v *View) mouseDown(e objc.ID) {
	p := msgPoint(v.content, "convertPoint:fromView:", msgPoint(e, "locationInWindow"), objc.ID(0))
	if i := v.rowAt(p.Y); i >= 0 {
		if v.ev.Click != nil {
			v.ev.Click(i)
		}
		return
	}
	msg(v.panel, "performWindowDragWithEvent:", e)
}

// scrollWheel counts each wheel line as one row, and adds trackpad points up to rows.
func (v *View) scrollWheel(e objc.ID) {
	if !v.visible || v.ev.Scroll == nil {
		return
	}
	dy := objc.Send[float64](e, sel("scrollingDeltaY"))
	if msgBool(e, "hasPreciseScrollingDeltas") {
		dy /= view.RowH
	}
	// A positive delta moves the content down, which brings the rows above into view.
	v.scrolled -= dy
	n := int(v.scrolled)
	v.scrolled -= float64(n)
	if n != 0 {
		v.ev.Scroll(n)
	}
}

// rowAt returns the drawn row at y, measured from the panel's top, or -1.
func (v *View) rowAt(y float64) int { return view.RowAt(y, v.snap) }

// mouseScreen returns the visible frame of the screen that has the mouse.
func mouseScreen(screens objc.ID) nsRect {
	m := msgPoint(class("NSEvent"), "mouseLocation")
	for i := uint(0); i < objc.Send[uint](screens, sel("count")); i++ {
		s := msg(screens, "objectAtIndex:", i)
		f := msgRect(s, "frame")
		if m.X >= f.Origin.X && m.X < f.Origin.X+f.Size.W && m.Y >= f.Origin.Y && m.Y < f.Origin.Y+f.Size.H {
			return msgRect(s, "visibleFrame")
		}
	}
	return msgRect(msg(class("NSScreen"), "mainScreen"), "visibleFrame")
}

func onScreen(screens objc.ID, x, y float64) bool {
	for i := uint(0); i < objc.Send[uint](screens, sel("count")); i++ {
		f := msgRect(msg(screens, "objectAtIndex:", i), "visibleFrame")
		if x >= f.Origin.X && x < f.Origin.X+f.Size.W && y >= f.Origin.Y && y < f.Origin.Y+f.Size.H {
			return true
		}
	}
	return false
}

// ActivateApp makes the app active. Call it on the main thread while a key press or click from
// the user is being handled. From macOS 14, an app that asks to be activated is only activated at
// that moment (cooperative activation). The panel never activates the app, because it is
// non-activating.
func ActivateApp() {
	app := msg(class("NSApplication"), "sharedApplication")
	if msgBool(app, "respondsToSelector:", sel("activate")) {
		msg(app, "activate")
		return
	}
	msg(app, "activateIgnoringOtherApps:", true)
}
