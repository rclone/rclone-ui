//go:build linux

package interaction

// The prompt on Linux is a GTK 4 window of the app's own. It calls the GTK that Wails has already
// loaded into the process, through purego, so there is no C code of our own and the package
// builds, and can be vetted, on any machine. Each function is declared with its C signature
// beside it. A gboolean is passed and read as an int32, because it is a C int. Strings are copied
// to C only for the length of a call, so every function that takes one must copy it, and all of
// the functions below do.

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"

	"github.com/ebitengine/purego"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/core/i18n"
)

const (
	gtkOrientationHorizontal = 0 // GtkOrientation
	gtkOrientationVertical   = 1
	gtkAlignEnd              = 2      // GtkAlign
	keyEscape                = 0xff1b // GDK_KEY_Escape
)

// gtk4
var (
	gtkIsInitialized            func() int32                             // gboolean gtk_is_initialized (void)
	gtkWindowNew                func() uintptr                           // GtkWidget *gtk_window_new (void)
	gtkWindowSetTitle           func(w uintptr, title string)            // void (GtkWindow*, const char*)
	gtkWindowSetModal           func(w uintptr, on int32)                // void (GtkWindow*, gboolean)
	gtkWindowSetResizable       func(w uintptr, on int32)                // void (GtkWindow*, gboolean)
	gtkWindowSetChild           func(w, child uintptr)                   // void (GtkWindow*, GtkWidget*)
	gtkWindowSetDefaultWidget   func(w, child uintptr)                   // void (GtkWindow*, GtkWidget*)
	gtkWindowPresent            func(w uintptr)                          // void (GtkWindow*)
	gtkWindowDestroy            func(w uintptr)                          // void (GtkWindow*)
	gtkBoxNew                   func(orientation, spacing int32) uintptr // GtkWidget *(GtkOrientation, int)
	gtkBoxAppend                func(box, child uintptr)                 // void (GtkBox*, GtkWidget*)
	gtkBoxSetHomogeneous        func(box uintptr, on int32)              // void (GtkBox*, gboolean)
	gtkWidgetSetMarginTop       func(w uintptr, margin int32)            // void (GtkWidget*, int)
	gtkWidgetSetMarginBottom    func(w uintptr, margin int32)            // void (GtkWidget*, int)
	gtkWidgetSetMarginStart     func(w uintptr, margin int32)            // void (GtkWidget*, int)
	gtkWidgetSetMarginEnd       func(w uintptr, margin int32)            // void (GtkWidget*, int)
	gtkWidgetSetHalign          func(w uintptr, align int32)             // void (GtkWidget*, GtkAlign)
	gtkWidgetAddCSSClass        func(w uintptr, class string)            // void (GtkWidget*, const char*)
	gtkWidgetAddController      func(w, controller uintptr)              // void (GtkWidget*, GtkEventController*); takes ownership
	gtkWidgetGrabFocus          func(w uintptr) int32                    // gboolean (GtkWidget*)
	gtkLabelNew                 func(text string) uintptr                // GtkWidget *(const char*)
	gtkLabelSetWrap             func(l uintptr, on int32)                // void (GtkLabel*, gboolean)
	gtkLabelSetMaxWidthChars    func(l uintptr, n int32)                 // void (GtkLabel*, int)
	gtkLabelSetXalign           func(l uintptr, x float32)               // void (GtkLabel*, float)
	gtkEntryNew                 func() uintptr                           // GtkWidget *(void)
	gtkPasswordEntryNew         func() uintptr                           // GtkWidget *(void)
	gtkPasswordEntrySetShowPeek func(e uintptr, on int32)                // void gtk_password_entry_set_show_peek_icon (GtkPasswordEntry*, gboolean)
	gtkEditableSetText          func(e uintptr, text string)             // void (GtkEditable*, const char*)
	gtkEditableGetText          func(e uintptr) string                   // const char *(GtkEditable*); owned by the widget, and purego copies it
	gtkButtonNewWithMnemonic    func(label string) uintptr               // GtkWidget *(const char*)
	gtkEventControllerKeyNew    func() uintptr                           // GtkEventController *(void)
)

// glib and gobject
var (
	gMainContextDefault func() uintptr          // GMainContext *g_main_context_default (void)
	gMainContextIsOwner func(ctx uintptr) int32 // gboolean g_main_context_is_owner (GMainContext*)
	// gulong g_signal_connect_data (gpointer, const gchar*, GCallback, gpointer, GClosureNotify, GConnectFlags)
	gSignalConnectData func(instance uintptr, signal string, handler, data, destroy uintptr, flags int32) uint64
)

// The signal handlers, as C function pointers from purego.NewCallback. They are made once, in
// load, because purego never frees a callback. Each one is given the prompt's id as its user data.
var (
	// void (GtkWidget*, gpointer), for OK's "clicked" and the entry's "activate"
	onOK uintptr
	// void (GtkButton*, gpointer), for Cancel's "clicked"
	onCancel uintptr
	// gboolean (GtkEventControllerKey*, guint keyval, guint keycode, GdkModifierType, gpointer),
	// for the key controller's "key-pressed"
	onKey uintptr
	// gboolean (GtkWindow*, gpointer), for the window's "close-request"
	onClose uintptr
)

var (
	loadOnce sync.Once
	errLoad  error
)

// load binds the functions above and makes the signal handlers, once. Wails links GTK 4 into
// the app, so dlopen returns the GTK that is already loaded rather than a second copy.
func load() error {
	loadOnce.Do(func() { errLoad = bindGTK() })
	return errLoad
}

func bindGTK() (err error) {
	defer func() {
		// RegisterLibFunc panics when a symbol is missing.
		if r := recover(); r != nil {
			err = fmt.Errorf("binding GTK 4: %v", r)
		}
	}()
	open := func(name string) (uintptr, error) {
		h, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return 0, fmt.Errorf("loading %s: %w", name, err)
		}
		return h, nil
	}
	gtk, err := open("libgtk-4.so.1")
	if err != nil {
		return err
	}
	glib, err := open("libglib-2.0.so.0")
	if err != nil {
		return err
	}
	gobject, err := open("libgobject-2.0.so.0")
	if err != nil {
		return err
	}
	bind := func(lib uintptr, fn any, name string) { purego.RegisterLibFunc(fn, lib, name) }

	bind(gtk, &gtkIsInitialized, "gtk_is_initialized")
	bind(gtk, &gtkWindowNew, "gtk_window_new")
	bind(gtk, &gtkWindowSetTitle, "gtk_window_set_title")
	bind(gtk, &gtkWindowSetModal, "gtk_window_set_modal")
	bind(gtk, &gtkWindowSetResizable, "gtk_window_set_resizable")
	bind(gtk, &gtkWindowSetChild, "gtk_window_set_child")
	bind(gtk, &gtkWindowSetDefaultWidget, "gtk_window_set_default_widget")
	bind(gtk, &gtkWindowPresent, "gtk_window_present")
	bind(gtk, &gtkWindowDestroy, "gtk_window_destroy")
	bind(gtk, &gtkBoxNew, "gtk_box_new")
	bind(gtk, &gtkBoxAppend, "gtk_box_append")
	bind(gtk, &gtkBoxSetHomogeneous, "gtk_box_set_homogeneous")
	bind(gtk, &gtkWidgetSetMarginTop, "gtk_widget_set_margin_top")
	bind(gtk, &gtkWidgetSetMarginBottom, "gtk_widget_set_margin_bottom")
	bind(gtk, &gtkWidgetSetMarginStart, "gtk_widget_set_margin_start")
	bind(gtk, &gtkWidgetSetMarginEnd, "gtk_widget_set_margin_end")
	bind(gtk, &gtkWidgetSetHalign, "gtk_widget_set_halign")
	bind(gtk, &gtkWidgetAddCSSClass, "gtk_widget_add_css_class")
	bind(gtk, &gtkWidgetAddController, "gtk_widget_add_controller")
	bind(gtk, &gtkWidgetGrabFocus, "gtk_widget_grab_focus")
	bind(gtk, &gtkLabelNew, "gtk_label_new")
	bind(gtk, &gtkLabelSetWrap, "gtk_label_set_wrap")
	bind(gtk, &gtkLabelSetMaxWidthChars, "gtk_label_set_max_width_chars")
	bind(gtk, &gtkLabelSetXalign, "gtk_label_set_xalign")
	bind(gtk, &gtkEntryNew, "gtk_entry_new")
	bind(gtk, &gtkPasswordEntryNew, "gtk_password_entry_new")
	bind(gtk, &gtkPasswordEntrySetShowPeek, "gtk_password_entry_set_show_peek_icon")
	bind(gtk, &gtkEditableSetText, "gtk_editable_set_text")
	bind(gtk, &gtkEditableGetText, "gtk_editable_get_text")
	bind(gtk, &gtkButtonNewWithMnemonic, "gtk_button_new_with_mnemonic")
	bind(gtk, &gtkEventControllerKeyNew, "gtk_event_controller_key_new")
	bind(glib, &gMainContextDefault, "g_main_context_default")
	bind(glib, &gMainContextIsOwner, "g_main_context_is_owner")
	bind(gobject, &gSignalConnectData, "g_signal_connect_data")

	// Every handler does its work inside guard, through withPrompt, because a panic can't unwind
	// through GTK's C frames.
	onOK = purego.NewCallback(func(_, data uintptr) {
		withPrompt(data, "ok", func(p *promptWindow) {
			p.end(answer{value: gtkEditableGetText(p.entry), ok: true}, true)
		})
	})
	onCancel = purego.NewCallback(func(_, data uintptr) {
		withPrompt(data, "cancel", func(p *promptWindow) { p.end(answer{}, true) })
	})
	onKey = purego.NewCallback(func(_ uintptr, keyval, _, _ uint32, data uintptr) uintptr {
		if keyval != keyEscape {
			return 0 // the key goes on to GTK
		}
		withPrompt(data, "escape", func(p *promptWindow) { p.end(answer{}, true) })
		return 1
	})
	onClose = purego.NewCallback(func(_, data uintptr) uintptr {
		withPrompt(data, "close", func(p *promptWindow) { p.end(answer{}, false) })
		return 0 // GTK destroys the window itself
	})
	return nil
}

type answer struct {
	value string
	ok    bool
	err   error
}

// promptWindow is an open prompt. Apart from its place in prompts, it is only used on the main
// thread.
type promptWindow struct {
	id            uintptr
	window, entry uintptr
	answers       chan<- answer
	done          bool // the answer was sent, so any later signal does nothing
}

// prompts holds the open prompts by their id, which their signal handlers are given in place of a
// Go pointer. A handler that runs after its prompt ended finds nothing.
var (
	promptsMu  sync.Mutex
	prompts    = map[uintptr]*promptWindow{}
	lastPrompt uintptr
)

// prompt shows a GTK 4 window on the main thread and waits for its answer here. GTK 4 has no
// gtk_dialog_run, so the window answers through a channel. Waiting on the main thread would stop
// the main loop that runs the window, and before the app runs there is no main loop, so both
// return an error instead of hanging.
func prompt(title, message, def string, sensitive bool) (string, bool, error) {
	if err := load(); err != nil {
		return "", false, err
	}
	app := application.Get()
	if app == nil || gtkIsInitialized() == 0 {
		return "", false, errors.New("the prompt can't open before the app runs")
	}
	// GApplication holds the default main context for as long as it runs, on the main thread.
	if gMainContextIsOwner(gMainContextDefault()) != 0 {
		return "", false, errors.New("the prompt can't wait on the main thread")
	}
	answers := make(chan answer, 1) // room for the one answer, so the main thread never waits
	activate()
	application.InvokeAsync(func() { openPrompt(title, message, def, sensitive, answers) })
	select {
	case a := <-answers:
		return a.value, a.ok, a.err
	case <-app.Context().Done():
		return "", false, errors.New("the app quit before the prompt was answered")
	}
}

// openPrompt builds the prompt and shows it, on the main thread: a modal window with the message,
// an entry holding def, and Cancel and OK buttons. OK is the default, and Enter in the entry
// chooses it. Escape and closing the window cancel. GTK 4 can't keep a window above the others or
// choose where it goes, so the compositor places it.
func openPrompt(title, message, def string, sensitive bool, answers chan<- answer) {
	promptsMu.Lock()
	lastPrompt++
	p := &promptWindow{id: lastPrompt, answers: answers}
	prompts[p.id] = p
	promptsMu.Unlock()
	p.guard("open", func() {
		p.window = gtkWindowNew()
		gtkWindowSetTitle(p.window, title)
		gtkWindowSetModal(p.window, 1)
		gtkWindowSetResizable(p.window, 0)

		box := gtkBoxNew(gtkOrientationVertical, 12)
		gtkWidgetSetMarginTop(box, 18)
		gtkWidgetSetMarginBottom(box, 18)
		gtkWidgetSetMarginStart(box, 18)
		gtkWidgetSetMarginEnd(box, 18)

		label := gtkLabelNew(message)
		gtkLabelSetWrap(label, 1)
		gtkLabelSetMaxWidthChars(label, 60)
		gtkLabelSetXalign(label, 0)
		gtkBoxAppend(box, label)

		// A password entry hides what is typed, and its eye icon shows it again.
		if sensitive {
			p.entry = gtkPasswordEntryNew()
			gtkPasswordEntrySetShowPeek(p.entry, 1)
		} else {
			p.entry = gtkEntryNew()
		}
		gtkEditableSetText(p.entry, def)
		gtkBoxAppend(box, p.entry)

		buttons := gtkBoxNew(gtkOrientationHorizontal, 6)
		gtkBoxSetHomogeneous(buttons, 1)
		gtkWidgetSetHalign(buttons, gtkAlignEnd)
		gtkWidgetSetMarginTop(buttons, 6)
		// i18n: A prompt's button. The underscore marks the letter that Alt presses it with: keep one.
		cancel := gtkButtonNewWithMnemonic(i18n.T("_Cancel"))
		// i18n: A prompt's button. The underscore marks the letter that Alt presses it with: keep one.
		ok := gtkButtonNewWithMnemonic(i18n.T("_OK"))
		gtkWidgetAddCSSClass(ok, "suggested-action")
		gtkBoxAppend(buttons, cancel)
		gtkBoxAppend(buttons, ok)
		gtkBoxAppend(box, buttons)
		gtkWindowSetChild(p.window, box)
		gtkWindowSetDefaultWidget(p.window, ok)

		// The entry's "activate" is Enter. It chooses OK directly, rather than through the default
		// widget, so OK can't be chosen twice.
		connect(ok, "clicked", onOK, p.id)
		connect(p.entry, "activate", onOK, p.id)
		connect(cancel, "clicked", onCancel, p.id)
		connect(p.window, "close-request", onClose, p.id)
		// The key controller is on the window and sees a key only after the entry has passed on
		// it, so Escape still ends an input method's composition first.
		keys := gtkEventControllerKeyNew()
		connect(keys, "key-pressed", onKey, p.id)
		gtkWidgetAddController(p.window, keys)

		gtkWindowPresent(p.window)
		gtkWidgetGrabFocus(p.entry)
	})
}

func connect(obj uintptr, signal string, handler, id uintptr) {
	_ = gSignalConnectData(obj, signal, handler, id, 0, 0)
}

// withPrompt runs body for the prompt with this id, inside guard. It does nothing when the prompt
// has ended.
func withPrompt(id uintptr, name string, body func(p *promptWindow)) {
	promptsMu.Lock()
	p := prompts[id]
	promptsMu.Unlock()
	if p != nil {
		p.guard(name, func() { body(p) })
	}
}

// end sends the answer, once, and forgets the prompt. destroy closes the window. It is false when
// GTK is closing the window already.
func (p *promptWindow) end(a answer, destroy bool) {
	if p.done {
		return
	}
	p.done = true
	p.answers <- a
	promptsMu.Lock()
	delete(prompts, p.id)
	promptsMu.Unlock()
	if destroy && p.window != 0 {
		gtkWindowDestroy(p.window)
	}
}

// guard runs body, which builds the prompt or handles one of its signals, on the main thread. A
// panic can't be allowed to unwind through GTK's C frames, because that would crash the app and
// stop every mount and transfer with it. So guard recovers the panic, logs it, and ends the prompt
// with an error, which the waiting caller receives.
func (p *promptWindow) guard(name string, body func()) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		slog.Error("interaction: the prompt panicked", "callback", name, "panic", r, "stack", string(debug.Stack()))
		// Closing the window can't be allowed to panic again either.
		defer func() { _ = recover() }()
		p.end(answer{err: fmt.Errorf("the prompt failed: %v", r)}, true)
	}()
	body()
}
