package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/rclone/rclone-ui/app/interaction"
)

// notifier shows OS toasts through Wails' notifications service, which uses
// UNUserNotificationCenter on macOS, toasts on Windows and the freedesktop D-Bus service on Linux.
// It is started by hand rather than as a bound service, because a failed start must only disable
// toasts, not stop the app. (An unbundled macOS build has no bundle identifier, so its start
// fails.) A click on a toast with a route opens that route's window.
type notifier struct {
	log *slog.Logger
	svc *notifications.NotificationService
	// open opens the window for a clicked toast. dialog shows a toast that the OS didn't show.
	open   func(route string)
	dialog func(title, body string)

	mu    sync.Mutex
	ready bool
	ok    bool // toasts are allowed
	asked bool // the OS was already asked, and isn't asked again in this run
}

// toast is a notification. route is the window that a click opens, such as "/history?id=…", or
// "" for none. toastOnly marks a notification that is only shown as a toast, such as the end of a
// transfer, which History, the tray and the launcher also show. Where toasts can't be shown,
// such a notification is dropped.
type toast struct {
	title, body string
	route       string
	toastOnly   bool
}

// routeKey is the key for the route in a toast's data. The OS passes the data back on a click.
const routeKey = "route"

func newNotifier(log *slog.Logger, open func(route string)) *notifier {
	n := &notifier{
		log:    log,
		svc:    notifications.New(),
		open:   open,
		dialog: func(title, body string) { interaction.Message(interaction.Info, title, body) },
	}
	// Set this before the start, because Windows delivers clicks on toasts from an earlier run as
	// soon as the service starts.
	n.svc.OnNotificationResponse(n.responded)
	return n
}

// start starts the OS's notification service. It runs on Wails' main thread: on Windows the
// service registers the toast activator's COM class, which fails on a thread without COM
// ("CoInitialize has not been called"), and only the main thread has it. Wails starts its own
// services there for the same reason.
func (n *notifier) start() {
	var err error
	application.InvokeSync(func() {
		err = n.svc.ServiceStartup(context.Background(), application.ServiceOptions{})
	})
	n.mu.Lock()
	n.ready = err == nil
	n.mu.Unlock()
	if err != nil {
		n.log.Warn("OS notifications are unavailable", "error", err)
	}
}

// allowed reports whether toasts may be shown. The first time the OS says no, it asks the OS for
// permission.
func (n *notifier) allowed() (bool, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.ready {
		return false, errors.New("OS notifications are unavailable")
	}
	if n.ok {
		return true, nil
	}
	ok, err := n.svc.CheckNotificationAuthorization()
	if err == nil && !ok && !n.asked {
		n.asked = true
		ok, err = n.svc.RequestNotificationAuthorization()
	}
	n.ok = ok
	return ok, err
}

func (n *notifier) send(title, body string) { n.show(toast{title: title, body: body}) }

// show shows a toast. Where toasts aren't allowed or can't be shown, it shows the same message
// in a dialog (see fallBack).
func (n *notifier) show(t toast) {
	if ok, err := n.allowed(); !ok {
		n.log.Info("toast not allowed", "title", t.title, "error", err)
		n.fallBack(t)
		return
	}
	if err := n.svc.SendNotification(t.options()); err != nil {
		n.log.Warn("could not show a toast", "title", t.title, "error", err)
		n.fallBack(t)
	}
}

// fallBack shows a toast that the OS didn't show as a dialog, so the user never misses the
// message. A toast-only notification is dropped instead, because it is shown elsewhere too, and a
// dialog for every transfer would get in the way.
func (n *notifier) fallBack(t toast) {
	if t.toastOnly {
		n.log.Info("dropped a toast-only notification", "title", t.title)
		return
	}
	n.dialog(t.title, t.body)
}

// options returns the toast's options for the OS, with a new ID. The route is stored in the data.
// On Linux, a notification server without the "actions" capability reports a toast that the user
// closed the same way as a click (Wails #6334), so there closing a toast also opens its window.
// Servers with actions, which most desktops run, report the two apart.
func (t toast) options() notifications.NotificationOptions {
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	o := notifications.NotificationOptions{ID: hex.EncodeToString(id), Title: t.title, Body: t.body}
	if t.route != "" {
		o.Data = map[string]any{routeKey: t.route}
	}
	return o
}

func (n *notifier) responded(r notifications.NotificationResult) {
	if r.Error != nil {
		n.log.Warn("could not read a toast's response", "error", r.Error)
		return
	}
	route, ok := clickedRoute(r.Response)
	if !ok {
		return
	}
	n.log.Info("toast clicked", "route", route)
	// Open the window outside the OS's callback, which may run on the main thread. Opening a
	// window waits for the main thread.
	go n.open(route)
}

// clickedRoute returns the route that a toast's response opens. The response must be a click on
// the toast itself (toasts have no buttons), and the route must be one of the app's routes.
func clickedRoute(r notifications.NotificationResponse) (string, bool) {
	if r.ActionIdentifier != notifications.DefaultActionIdentifier {
		return "", false
	}
	route, _ := r.UserInfo[routeKey].(string)
	return route, appRoute(route)
}

// appRoute reports whether route is one of the app's pages, such as "/history?id=…". It must
// not be an outside URL, because a window would load it with access to the app's bindings. On
// Windows any program can send the app a click with its own data.
func appRoute(route string) bool {
	if !strings.HasPrefix(route, "/") || strings.HasPrefix(route, "//") || strings.Contains(route, `\`) {
		return false
	}
	u, err := url.Parse(route)
	return err == nil && u.Scheme == "" && u.Host == ""
}
