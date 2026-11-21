//go:build linux

package linux

// This file places the launcher's window and gives it the keyboard. It calls GTK 4, GDK's X11
// and Wayland backends, Xlib and gtk4-layer-shell through purego. These are libraries that the
// app has already loaded, so dlopen returns them rather than loading second copies. In GTK 4,
// GDK is part of libgtk-4. Each function is declared with its C signature beside it. A gboolean
// result is read as an int32, because it is a C int.

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

// Enum values from gtk4-layer-shell.
const (
	layerOverlay      = 3 // GtkLayerShellLayer, above full-screen windows
	edgeLeft          = 0 // GtkLayerShellEdge
	edgeTop           = 2
	keyboardExclusive = 1 // GtkLayerShellKeyboardMode
	keyboardOnDemand  = 2 // layer-shell protocol 4 and later
)

// Values from Xlib.
const (
	xaAtom          = 4 // XA_ATOM
	propModeReplace = 0
	xButtonsMask    = 1<<8 | 1<<9 | 1<<10 // Button1Mask to Button3Mask
	allDesktops     = 0xFFFFFFFF          // the _NET_WM_DESKTOP of a window on every workspace
)

// namespace is the layer surface's namespace, which compositors use in their rules.
const namespace = "rclone-ui-launcher"

// rect is a GdkRectangle, such as a monitor's work area.
type rect struct{ X, Y, W, H int32 }

func (r rect) contains(x, y float64) bool {
	return x >= float64(r.X) && x < float64(r.X+r.W) && y >= float64(r.Y) && y < float64(r.Y+r.H)
}

// GTK 4 and GLib
var (
	gdkDisplayGetDefault       func() uintptr                       // GdkDisplay *gdk_display_get_default (void)
	gTypeNameFromInstance      func(instance uintptr) string        // const gchar *g_type_name_from_instance (GTypeInstance*)
	gObjectRef                 func(obj uintptr) uintptr            // gpointer g_object_ref (gpointer)
	gObjectUnref               func(obj uintptr)                    // void g_object_unref (gpointer)
	gtkWidgetRealize           func(w uintptr)                      // void gtk_widget_realize (GtkWidget*)
	gtkWidgetGetRealized       func(w uintptr) int32                // gboolean gtk_widget_get_realized (GtkWidget*)
	gtkWidgetGetMapped         func(w uintptr) int32                // gboolean gtk_widget_get_mapped (GtkWidget*)
	gtkWidgetQueueDraw         func(w uintptr)                      // void gtk_widget_queue_draw (GtkWidget*); a commit applies layer changes
	gtkNativeGetSurface        func(native uintptr) uintptr         // GdkSurface *gtk_native_get_surface (GtkNative*)
	gtkWindowPresent           func(w uintptr)                      // void gtk_window_present (GtkWindow*)
	gtkWindowPresentWithTime   func(w uintptr, t uint32)            // void gtk_window_present_with_time (GtkWindow*, guint32)
	gtkWindowSetStartupID      func(w uintptr, id string)           // void gtk_window_set_startup_id (GtkWindow*, const char*)
	gtkWindowSetTitle          func(w uintptr, title string)        // void gtk_window_set_title (GtkWindow*, const char*)
	gdkDisplayGetMonitors      func(d uintptr) uintptr              // GListModel *gdk_display_get_monitors (GdkDisplay*)
	gListModelGetNItems        func(list uintptr) uint32            // guint g_list_model_get_n_items (GListModel*)
	gListModelGetItem          func(list uintptr, i uint32) uintptr // gpointer g_list_model_get_item (GListModel*, guint), a new reference
	gdkMonitorGetGeometry      func(m uintptr, r *rect)             // void gdk_monitor_get_geometry (GdkMonitor*, GdkRectangle*)
	gdkMonitorIsValid          func(m uintptr) int32                // gboolean gdk_monitor_is_valid (GdkMonitor*)
	gdkDisplayMonitorAtSurface func(d, s uintptr) uintptr           // GdkMonitor *gdk_display_get_monitor_at_surface (GdkDisplay*, GdkSurface*)
)

// GDK's X11 backend and Xlib
var (
	gdkX11MonitorGetWorkarea func(m uintptr, r *rect)  // void gdk_x11_monitor_get_workarea (GdkMonitor*, GdkRectangle*)
	gdkX11DisplayGetXDisplay func(d uintptr) uintptr   // Display *gdk_x11_display_get_xdisplay (GdkDisplay*)
	gdkX11SurfaceGetXID      func(s uintptr) uintptr   // Window gdk_x11_surface_get_xid (GdkSurface*)
	gdkX11GetServerTime      func(s uintptr) uint32    // guint32 gdk_x11_get_server_time (GdkSurface*)
	gdkX11SetSkipTaskbar     func(s uintptr, on bool)  // void gdk_x11_surface_set_skip_taskbar_hint (GdkSurface*, gboolean)
	gdkX11SetSkipPager       func(s uintptr, on bool)  // void gdk_x11_surface_set_skip_pager_hint (GdkSurface*, gboolean)
	gdkX11MoveToDesktop      func(s uintptr, d uint32) // void gdk_x11_surface_move_to_desktop (GdkSurface*, guint32)
	xDefaultRootWindow       func(dpy uintptr) uintptr // Window XDefaultRootWindow (Display*)
	// Bool XQueryPointer (Display*, Window, Window *root, Window *child, int *root_x, int *root_y,
	// int *win_x, int *win_y, unsigned int *mask)
	xQueryPointer func(dpy, w uintptr, root, child *uintptr, rootX, rootY, winX, winY *int32, mask *uint32) int32
	xInternAtom   func(dpy uintptr, name string, onlyIfExists bool) uintptr // Atom XInternAtom (Display*, const char*, Bool)
	// int XChangeProperty (Display*, Window, Atom property, Atom type, int format, int mode,
	// const unsigned char *data, int nelements)
	xChangeProperty func(dpy, w, property, kind uintptr, format, mode int32, data unsafe.Pointer, n int32) int32
	xFlush          func(dpy uintptr) int32 // int XFlush (Display*)
)

// gtk4-layer-shell
var (
	layerIsSupported     func() int32                         // gboolean gtk_layer_is_supported (void)
	layerProtocolVersion func() uint32                        // guint gtk_layer_get_protocol_version (void)
	layerInitForWindow   func(w uintptr)                      // void gtk_layer_init_for_window (GtkWindow*)
	layerSetNamespace    func(w uintptr, ns string)           // void gtk_layer_set_namespace (GtkWindow*, const char*)
	layerSetLayer        func(w uintptr, layer int32)         // void gtk_layer_set_layer (GtkWindow*, GtkLayerShellLayer)
	layerSetMonitor      func(w, monitor uintptr)             // void gtk_layer_set_monitor (GtkWindow*, GdkMonitor*)
	layerSetAnchor       func(w uintptr, edge int32, on bool) // void gtk_layer_set_anchor (GtkWindow*, GtkLayerShellEdge, gboolean)
	layerSetMargin       func(w uintptr, edge, size int32)    // void gtk_layer_set_margin (GtkWindow*, GtkLayerShellEdge, int)
	layerSetKeyboardMode func(w uintptr, mode int32)          // void gtk_layer_set_keyboard_mode (GtkWindow*, GtkLayerShellKeyboardMode)
)

// The libraries, bound once. layerBound reports whether gtk4-layer-shell was found. The app links
// it (link_linux.go), so only a build without cgo, which is for development, can lack it. x11Bound
// reports whether Xlib was found.
var (
	bindOnce   sync.Once
	bindErr    error
	layerBound bool
	x11Bound   bool
)

func bind() error {
	bindOnce.Do(func() { bindErr = bindAll() })
	return bindErr
}

func bindAll() (err error) {
	defer func() {
		if r := recover(); r != nil { // purego panics when a symbol is missing
			err = fmt.Errorf("GTK 4 lacks a function the launcher needs: %v", r)
		}
	}()
	open := func(name string) (uintptr, error) {
		h, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return 0, fmt.Errorf("the launcher can't load %s: %w", name, err)
		}
		return h, nil
	}
	gtk, err := open("libgtk-4.so.1")
	if err != nil {
		return err
	}
	gobject, err := open("libgobject-2.0.so.0")
	if err != nil {
		return err
	}
	gio, err := open("libgio-2.0.so.0")
	if err != nil {
		return err
	}
	bind := func(fn any, lib uintptr, name string) { purego.RegisterLibFunc(fn, lib, name) }
	bind(&gdkDisplayGetDefault, gtk, "gdk_display_get_default")
	bind(&gTypeNameFromInstance, gobject, "g_type_name_from_instance")
	bind(&gObjectRef, gobject, "g_object_ref")
	bind(&gObjectUnref, gobject, "g_object_unref")
	bind(&gtkWidgetRealize, gtk, "gtk_widget_realize")
	bind(&gtkWidgetGetRealized, gtk, "gtk_widget_get_realized")
	bind(&gtkWidgetGetMapped, gtk, "gtk_widget_get_mapped")
	bind(&gtkWidgetQueueDraw, gtk, "gtk_widget_queue_draw")
	bind(&gtkNativeGetSurface, gtk, "gtk_native_get_surface")
	bind(&gtkWindowPresent, gtk, "gtk_window_present")
	bind(&gtkWindowPresentWithTime, gtk, "gtk_window_present_with_time")
	bind(&gtkWindowSetStartupID, gtk, "gtk_window_set_startup_id")
	bind(&gtkWindowSetTitle, gtk, "gtk_window_set_title")
	bind(&gdkDisplayGetMonitors, gtk, "gdk_display_get_monitors")
	bind(&gListModelGetNItems, gio, "g_list_model_get_n_items")
	bind(&gListModelGetItem, gio, "g_list_model_get_item")
	bind(&gdkMonitorGetGeometry, gtk, "gdk_monitor_get_geometry")
	bind(&gdkMonitorIsValid, gtk, "gdk_monitor_is_valid")
	bind(&gdkDisplayMonitorAtSurface, gtk, "gdk_display_get_monitor_at_surface")
	// GTK is built with its X11 backend almost everywhere. Without it, or without Xlib, the
	// launcher works on Wayland only.
	if x11, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL); err == nil {
		x11Bound = bindX11(gtk, x11)
	}
	if lib, err := purego.Dlopen("libgtk4-layer-shell.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL); err == nil {
		bind(&layerIsSupported, lib, "gtk_layer_is_supported")
		bind(&layerProtocolVersion, lib, "gtk_layer_get_protocol_version")
		bind(&layerInitForWindow, lib, "gtk_layer_init_for_window")
		bind(&layerSetNamespace, lib, "gtk_layer_set_namespace")
		bind(&layerSetLayer, lib, "gtk_layer_set_layer")
		bind(&layerSetMonitor, lib, "gtk_layer_set_monitor")
		bind(&layerSetAnchor, lib, "gtk_layer_set_anchor")
		bind(&layerSetMargin, lib, "gtk_layer_set_margin")
		bind(&layerSetKeyboardMode, lib, "gtk_layer_set_keyboard_mode")
		layerBound = true
	}
	return nil
}

func bindX11(gtk, x11 uintptr) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	purego.RegisterLibFunc(&gdkX11MonitorGetWorkarea, gtk, "gdk_x11_monitor_get_workarea")
	purego.RegisterLibFunc(&gdkX11DisplayGetXDisplay, gtk, "gdk_x11_display_get_xdisplay")
	purego.RegisterLibFunc(&gdkX11SurfaceGetXID, gtk, "gdk_x11_surface_get_xid")
	purego.RegisterLibFunc(&gdkX11GetServerTime, gtk, "gdk_x11_get_server_time")
	purego.RegisterLibFunc(&gdkX11SetSkipTaskbar, gtk, "gdk_x11_surface_set_skip_taskbar_hint")
	purego.RegisterLibFunc(&gdkX11SetSkipPager, gtk, "gdk_x11_surface_set_skip_pager_hint")
	purego.RegisterLibFunc(&gdkX11MoveToDesktop, gtk, "gdk_x11_surface_move_to_desktop")
	purego.RegisterLibFunc(&xDefaultRootWindow, x11, "XDefaultRootWindow")
	purego.RegisterLibFunc(&xQueryPointer, x11, "XQueryPointer")
	purego.RegisterLibFunc(&xInternAtom, x11, "XInternAtom")
	purego.RegisterLibFunc(&xChangeProperty, x11, "XChangeProperty")
	purego.RegisterLibFunc(&xFlush, x11, "XFlush")
	return true
}

type platform struct {
	win     *application.WebviewWindow
	window  uintptr // the GtkWindow
	display uintptr // the GdkDisplay
	mode    Mode

	// left and top are the window's top-left corner: where the view put an X11 window, or a
	// layer surface's margins.
	left, top int

	// A layer surface is centred on the monitor that the compositor chooses, until the user drags
	// it. From then on it stays on the monitor it was dragged on (placed, which holds a
	// reference), at its margins. monitorH is the height of the monitor that it was last centred
	// on, and dragFrom is where the pointer pressed for a drag.
	placed               uintptr
	monitorH             int32
	dragFromX, dragFromY float64
}

// NewPlatform returns the platform of win, the launcher's window, which must be hidden and never
// shown yet. It decides how the window is shown. On a Wayland compositor that supports
// layer-shell, it makes the window a layer surface. That must happen before GTK realizes the
// window, because the surface is created then. It must run on the main thread.
func NewPlatform(win *application.WebviewWindow) (Platform, error) {
	if err := bind(); err != nil {
		return nil, err
	}
	p := &platform{win: win, window: uintptr(win.NativeWindow()), display: gdkDisplayGetDefault()}
	if p.window == 0 || p.display == 0 {
		return nil, errors.New("the launcher's window has no GTK window or display")
	}
	// Wails gives a frameless window no title, and the GNOME extension recognises the launcher by
	// its title.
	gtkWindowSetTitle(p.window, Title)
	switch kind := gTypeNameFromInstance(p.display); kind {
	case "GdkWaylandDisplay":
		p.mode = ModeWayland
		// gtk_layer_is_supported asks the compositor, so the display must be open, which it is.
		if layerBound && layerIsSupported() != 0 && gtkWidgetGetRealized(p.window) == 0 {
			p.mode = ModeLayer
			// The surface goes above full-screen windows, with its top edge anchored. It is
			// centred horizontally, or placed from the left once dragged, and it takes the
			// keyboard when shown.
			layerInitForWindow(p.window)
			layerSetNamespace(p.window, namespace)
			layerSetLayer(p.window, layerOverlay)
			layerSetAnchor(p.window, edgeTop, true)
			layerSetKeyboardMode(p.window, keyboardExclusive)
		}
	case "GdkX11Display":
		if !x11Bound {
			return nil, errors.New("the launcher can't use X11: GTK lacks its X11 backend, or Xlib is missing")
		}
		p.mode = ModeX11
		// The window needs its X window before it is shown, for the hints that X11 window
		// managers read when it maps (see hints).
		gtkWidgetRealize(p.window)
	default:
		return nil, fmt.Errorf("the launcher doesn't support GTK's %s", kind)
	}
	return p, nil
}

func (p *platform) Mode() Mode { return p.mode }

func (p *platform) BeforeShow(at *view.Placement, token string) {
	switch p.mode {
	case ModeX11:
		px, py := p.pointer()
		if at != nil && p.onScreen(at.Left+view.Width/2, at.Top+view.QueryH/2) {
			p.left, p.top = int(at.Left), int(at.Top)
		} else {
			wa := p.workArea(px, py)
			dx, dy := view.Centred(float64(wa.W), float64(wa.H), 1)
			p.left, p.top = int(wa.X)+int(dx), int(wa.Y)+int(dy)
		}
		p.hints()
		p.win.SetPosition(p.left, p.top)
	case ModeLayer:
		p.placeLayer(at)
	case ModeWayland:
		if token != "" {
			// GTK activates the window with the token (xdg-activation). The compositor gives the
			// keyboard to a window that presents the token from the user's own key press.
			gtkWindowSetStartupID(p.window, token)
		}
	}
}

func (p *platform) AfterShow() {
	switch p.mode {
	case ModeX11:
		// Set the position again, because some window managers place a window when it maps. Then
		// present the window with the X server's current time. The shortcut arrives from outside
		// GTK, so GTK has no event time to use, and a window manager refuses the keyboard to a
		// request that is older than the user's last action.
		p.win.SetPosition(p.left, p.top)
		if s := gtkNativeGetSurface(p.window); s != 0 {
			gdkX11MoveToDesktop(s, allDesktops)
			gtkWindowPresentWithTime(p.window, gdkX11GetServerTime(s))
			return
		}
	case ModeLayer:
		p.fitLayer()
	}
	gtkWindowPresent(p.window)
}

func (p *platform) Resized(visible bool) {
	if visible && p.mode == ModeX11 {
		p.win.SetPosition(p.left, p.top)
	}
}

// Focused switches a layer surface's keyboard mode to on-demand where the protocol allows it
// (version 4), once the surface has the keyboard. A click on another window can then take the
// keyboard, and the launcher hides when it loses it, as it does everywhere else. The mode is
// exclusive until then, so the surface gets the keyboard when it is shown.
func (p *platform) Focused() {
	if p.mode != ModeLayer {
		return
	}
	p.fitLayer()
	if layerProtocolVersion() >= 4 {
		layerSetKeyboardMode(p.window, keyboardOnDemand)
		gtkWidgetQueueDraw(p.window)
	}
}

func (p *platform) Held() bool {
	if p.mode != ModeX11 {
		return false
	}
	_, _, mask, ok := p.queryPointer()
	return ok && mask&xButtonsMask != 0
}

func (p *platform) Moved() (view.Placement, bool) {
	if p.mode != ModeX11 {
		return view.Placement{}, false // Wayland doesn't say where windows are
	}
	x, y := p.win.Position()
	if x == p.left && y == p.top {
		return view.Placement{}, false // the view moved it
	}
	p.left, p.top = x, y
	return view.Placement{Left: float64(x), Top: float64(y)}, true
}

// DragStart starts moving a layer surface. From now on the surface is placed by its left and top
// margins on its current monitor. While it is shown, only its anchor and margins change. The
// monitor is set the next time it is shown (see setMonitor), and it stays on that monitor from
// then on.
func (p *platform) DragStart(x, y float64) {
	p.dragFromX, p.dragFromY = x, y
	if p.placed != 0 {
		return
	}
	m := p.monitorOfWindow()
	if m == 0 {
		return
	}
	var g rect
	gdkMonitorGetGeometry(m, &g)
	p.placed = gObjectRef(m)
	dx, _ := view.Centred(float64(g.W), float64(g.H), 1)
	p.left = int(dx) // where centring placed it
	layerSetAnchor(p.window, edgeLeft, true)
	layerSetMargin(p.window, edgeLeft, int32(p.left))
}

// DragTo moves the surface by the same distance as the pointer has moved from where it was
// pressed in the window. The compositor moves the surface a moment later, so a move reported in
// between is still measured from the old position. The moves that follow make up for it.
func (p *platform) DragTo(x, y float64) {
	if p.placed == 0 {
		return
	}
	left, top := dragMargins(p.left, p.top, x-p.dragFromX, y-p.dragFromY)
	if left == p.left && top == p.top {
		return
	}
	p.left, p.top = left, top
	layerSetMargin(p.window, edgeLeft, int32(left))
	layerSetMargin(p.window, edgeTop, int32(top))
	gtkWidgetQueueDraw(p.window)
}

func (p *platform) DragEnd() (view.Placement, bool) {
	if p.placed == 0 {
		return view.Placement{}, false
	}
	return view.Placement{Left: float64(p.left), Top: float64(p.top)}, true
}

// placeLayer sets where the layer surface appears. If the user dragged it and the monitor they
// dragged it to is still connected, it goes back there. Otherwise it is centred horizontally on
// the monitor that the compositor chooses, which is the one in use, with its top where a window
// with every row would be centred. That monitor isn't known until the surface maps, so the height
// of the last monitor is used until then, and fitLayer corrects it.
func (p *platform) placeLayer(at *view.Placement) {
	if at != nil && p.placed != 0 && gdkMonitorIsValid(p.placed) != 0 {
		p.left, p.top = int(at.Left), int(at.Top)
		p.setMonitor(p.placed)
		layerSetAnchor(p.window, edgeLeft, true)
		layerSetMargin(p.window, edgeLeft, int32(p.left))
	} else {
		p.unplace()
		if p.monitorH == 0 {
			if m := p.firstMonitor(); m != 0 {
				var g rect
				gdkMonitorGetGeometry(m, &g)
				p.monitorH = g.H
				gObjectUnref(m)
			}
		}
		p.top = topMargin(p.monitorH)
	}
	layerSetMargin(p.window, edgeTop, int32(p.top))
	layerSetKeyboardMode(p.window, keyboardExclusive)
}

// unplace centres the layer surface again, on the monitor that the compositor chooses.
func (p *platform) unplace() {
	if p.placed != 0 {
		gObjectUnref(p.placed)
		p.placed = 0
	}
	p.setMonitor(0)
	layerSetAnchor(p.window, edgeLeft, false)
	layerSetMargin(p.window, edgeLeft, 0)
}

// setMonitor puts the layer surface on monitor m, or lets the compositor choose when m is 0. It
// only does this while the surface is hidden, which is when the view places it.
// gtk4-layer-shell moves a mapped surface to another monitor by remapping it, which flickers and
// takes the pointer away from a drag in progress. A visible surface stays where it is until it is
// next shown.
func (p *platform) setMonitor(m uintptr) {
	if gtkWidgetGetMapped(p.window) == 0 {
		layerSetMonitor(p.window, m)
	}
}

// fitLayer corrects the top margin of a centred layer surface for the monitor it appeared on.
func (p *platform) fitLayer() {
	if p.placed != 0 {
		return
	}
	m := p.monitorOfWindow()
	if m == 0 {
		return
	}
	var g rect
	gdkMonitorGetGeometry(m, &g)
	if g.H == p.monitorH {
		return
	}
	p.monitorH = g.H
	p.top = topMargin(g.H)
	layerSetMargin(p.window, edgeTop, int32(p.top))
	gtkWidgetQueueDraw(p.window)
}

// monitorOfWindow returns the monitor that the shown window is on, or 0.
func (p *platform) monitorOfWindow() uintptr {
	s := gtkNativeGetSurface(p.window)
	if s == 0 {
		return 0
	}
	return gdkDisplayMonitorAtSurface(p.display, s)
}

// firstMonitor returns the first monitor, with a reference that the caller drops, or 0. GTK 4
// has no primary monitor.
func (p *platform) firstMonitor() uintptr {
	list := gdkDisplayGetMonitors(p.display)
	if list == 0 || gListModelGetNItems(list) == 0 {
		return 0
	}
	return gListModelGetItem(list, 0)
}

// eachMonitor calls fn with each monitor until it returns true.
func (p *platform) eachMonitor(fn func(m uintptr) bool) {
	list := gdkDisplayGetMonitors(p.display)
	if list == 0 {
		return
	}
	for i := range gListModelGetNItems(list) {
		m := gListModelGetItem(list, i)
		if m == 0 {
			continue
		}
		done := fn(m)
		gObjectUnref(m)
		if done {
			return
		}
	}
}

// workArea returns the work area of the monitor at (x, y), or else of the first monitor. On X11,
// GDK reads it from the window manager.
func (p *platform) workArea(x, y int32) rect {
	var wa, first rect
	found, haveFirst := false, false
	p.eachMonitor(func(m uintptr) bool {
		var g rect
		gdkMonitorGetGeometry(m, &g)
		var area rect
		gdkX11MonitorGetWorkarea(m, &area)
		if !haveFirst {
			first, haveFirst = area, true
		}
		if g.contains(float64(x), float64(y)) {
			wa, found = area, true
			return true
		}
		return false
	})
	if !found {
		return first
	}
	return wa
}

// onScreen reports whether (x, y) is inside the work area of any monitor. A position where the
// user left the window is only reused while its screen is still connected.
func (p *platform) onScreen(x, y float64) bool {
	on := false
	p.eachMonitor(func(m uintptr) bool {
		var wa rect
		gdkX11MonitorGetWorkarea(m, &wa)
		on = wa.contains(x, y)
		return on
	})
	return on
}

// pointer returns the pointer's position in root coordinates.
func (p *platform) pointer() (x, y int32) {
	x, y, _, _ = p.queryPointer()
	return x, y
}

// queryPointer asks the X server where the pointer is, and which of its buttons are down.
func (p *platform) queryPointer() (x, y int32, mask uint32, ok bool) {
	dpy := gdkX11DisplayGetXDisplay(p.display)
	if dpy == 0 {
		return 0, 0, 0, false
	}
	var root, child uintptr
	var wx, wy int32
	ok = xQueryPointer(dpy, xDefaultRootWindow(dpy), &root, &child, &x, &y, &wx, &wy, &mask) != 0
	return x, y, mask, ok
}

// hints sets what X11 window managers read when the window maps: it is a dialog, and it isn't
// listed in the taskbar or the pager. GDK keeps the two hints and writes them again whenever the
// window maps, so they go through GDK. Staying above the other windows is the window's
// AlwaysOnTop, and appearing on every workspace is set once it shows (AfterShow).
func (p *platform) hints() {
	s := gtkNativeGetSurface(p.window)
	dpy := gdkX11DisplayGetXDisplay(p.display)
	if s == 0 || dpy == 0 {
		return
	}
	gdkX11SetSkipTaskbar(s, true)
	gdkX11SetSkipPager(s, true)
	dialog := uint64(xInternAtom(dpy, "_NET_WM_WINDOW_TYPE_DIALOG", false))
	xChangeProperty(dpy, gdkX11SurfaceGetXID(s), xInternAtom(dpy, "_NET_WM_WINDOW_TYPE", false), xaAtom, 32,
		propModeReplace, unsafe.Pointer(&dialog), 1)
	xFlush(dpy)
}
