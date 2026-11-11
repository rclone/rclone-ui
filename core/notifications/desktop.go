package notifications

import (
	"context"

	"github.com/rclone/rclone-ui/core/bus"
)

// heldMax is how many desktop notifications wait for the UI to subscribe. More would only bury
// the first ones, which say what went wrong at the start.
const heldMax = 32

// Notifier sends the app's notifications. *Service is a Notifier.
type Notifier interface {
	// Notify sends an event to the notification targets that are subscribed to it.
	Notify(ctx context.Context, e NotificationEvent, p Payload)
	// Desktop shows an event as a desktop notification. The notification targets don't get it,
	// so a caller that wants both calls Notify too.
	Desktop(ctx context.Context, e NotificationEvent, p Payload, d Desktop)
}

// Desktop is how a desktop notification shows an event. No setting turns it off: the app shows
// the events that need the user whatever targets are set.
type Desktop struct {
	// Title and Body are the notification's text. When both are empty, it shows the payload's
	// message, redacted as the targets get it.
	Title, Body string
	// Route is the window that a click on the notification opens ("/history?id=…"). An empty
	// Route opens nothing.
	Route string
	// ToastOnly shows the notification as a toast or not at all, never as a dialog. It is for
	// the end of a transfer or of a schedule's run, which History and the tray show too.
	ToastOnly bool
}

// NotifyOS returns what bus.NotifyOS carries for event e with payload p.
func (d Desktop) NotifyOS(e NotificationEvent, p Payload) bus.NotifyOSData {
	title, body := d.Title, d.Body
	if title == "" && body == "" && p != nil {
		title, body = redacted(p).Message(e)
	}
	return bus.NotifyOSData{EventID: string(e), Title: title, Body: body, Route: d.Route, ToastOnly: d.ToastOnly}
}

// Desktop asks the UI to show event e as a desktop notification (bus.NotifyOS). Before the UI
// subscribes to the bus, nobody would hear it, so it is held until then. That happens at the
// start, when a resumed transfer or an automount fails before any window is open.
func (s *Service) Desktop(ctx context.Context, e NotificationEvent, p Payload, d Desktop) {
	if s.bus == nil {
		return
	}
	data := d.NotifyOS(e, p)
	s.desktopMu.Lock()
	defer s.desktopMu.Unlock()
	if s.heard {
		s.bus.Publish(bus.NotifyOS, data)
		return
	}
	if len(s.held) == heldMax {
		s.log.WarnContext(ctx, "desktop notification dropped: too many are waiting for the UI", "event", string(e))
		return
	}
	s.held = append(s.held, data)
}

// showHeld waits for the UI to subscribe, and then shows the desktop notifications that Desktop
// held.
func (s *Service) showHeld(ctx context.Context) {
	select {
	case <-s.bus.Heard():
	case <-ctx.Done():
		return
	}
	s.desktopMu.Lock()
	defer s.desktopMu.Unlock()
	s.heard = true
	// Publish never blocks, so the held ones go out in order before any later one.
	for _, data := range s.held {
		s.bus.Publish(bus.NotifyOS, data)
	}
	s.held = nil
}
