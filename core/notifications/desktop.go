package notifications

import (
	"context"

	"github.com/rclone/rclone-ui/core/bus"
)

const heldMax = 32

type Notifier interface {
	Notify(ctx context.Context, e NotificationEvent, p Payload)
	// Desktop shows an event as a desktop notification. The notification targets don't get it,
	// so a caller that wants both calls Notify too.
	Desktop(ctx context.Context, e NotificationEvent, p Payload, d Desktop)
}

type Desktop struct {
	// Title and Body are the notification's text. When both are empty, it shows the payload's
	// message, redacted as the targets get it.
	Title, Body string
	// Route is the window that a click on the notification opens ("/history?id=…"). An empty
	// Route opens nothing.
	Route     string
	ToastOnly bool
}

func (d Desktop) NotifyOS(e NotificationEvent, p Payload) bus.NotifyOSData {
	title, body := d.Title, d.Body
	if title == "" && body == "" && p != nil {
		title, body = redacted(p).Message(e)
	}
	return bus.NotifyOSData{EventID: string(e), Title: title, Body: body, Route: d.Route, ToastOnly: d.ToastOnly}
}

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

func (s *Service) showHeld(ctx context.Context) {
	select {
	case <-s.bus.Heard():
	case <-ctx.Done():
		return
	}
	s.desktopMu.Lock()
	defer s.desktopMu.Unlock()
	s.heard = true
	for _, data := range s.held {
		s.bus.Publish(bus.NotifyOS, data)
	}
	s.held = nil
}
