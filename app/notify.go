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

type notifier struct {
	log    *slog.Logger
	svc    *notifications.NotificationService
	open   func(route string)
	dialog func(title, body string)

	mu    sync.Mutex
	ready bool
	ok    bool
	asked bool
}

type toast struct {
	title, body string
	route       string
	toastOnly   bool
}

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

// On Windows the service registers the toast activator's COM class, which fails on a thread
// without COM ("CoInitialize has not been called"). Only Wails' main thread has it.
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

func (n *notifier) fallBack(t toast) {
	if t.toastOnly {
		n.log.Info("dropped a toast-only notification", "title", t.title)
		return
	}
	n.dialog(t.title, t.body)
}

// On Linux, a notification server without the "actions" capability reports a closed toast the
// same way as a click (Wails #6334), so there closing a toast also opens its window.
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
	// The OS's callback may run on the main thread, and opening a window waits for that thread.
	go n.open(route)
}

func clickedRoute(r notifications.NotificationResponse) (string, bool) {
	if r.ActionIdentifier != notifications.DefaultActionIdentifier {
		return "", false
	}
	route, _ := r.UserInfo[routeKey].(string)
	return route, appRoute(route)
}

// On Windows any program can send the app a toast click with its own data.
func appRoute(route string) bool {
	if !strings.HasPrefix(route, "/") || strings.HasPrefix(route, "//") || strings.Contains(route, `\`) {
		return false
	}
	u, err := url.Parse(route)
	return err == nil && u.Scheme == "" && u.Host == ""
}
