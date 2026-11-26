package notifications

import (
	"context"
	"sync"
	"time"
)

const StreakEnd = 5 * time.Minute

// Streak sends an event once per streak of failures, so a mount or serve in a crash loop is
// reported once instead of at every crash. The streak ends when the mount or serve has stayed up
// for StreakEnd. Use one Streak per mount or serve. It is safe for concurrent use.
type Streak struct {
	n       Notifier
	event   NotificationEvent
	desktop *Desktop
	now     func() time.Time

	mu   sync.Mutex
	open bool
	upAt time.Time
}

// NewStreak returns a Streak for one mount or serve that sends event through n. With a desktop,
// each event it sends is also shown as a desktop notification.
func NewStreak(n Notifier, event NotificationEvent, desktop *Desktop) *Streak {
	return &Streak{n: n, event: event, desktop: desktop, now: time.Now}
}

func (k *Streak) Up() {
	k.mu.Lock()
	k.upAt = k.now()
	k.mu.Unlock()
}

// Failed records that the mount or serve failed, either to start or while running. It sends p
// when this failure starts a new streak, and reports whether it did.
func (k *Streak) Failed(ctx context.Context, p Payload) bool {
	k.mu.Lock()
	stayedUp := !k.upAt.IsZero() && k.now().Sub(k.upAt) >= StreakEnd
	k.upAt = time.Time{}
	send := !k.open || stayedUp
	k.open = true
	k.mu.Unlock()
	if send {
		k.n.Notify(ctx, k.event, p)
		if k.desktop != nil {
			k.n.Desktop(ctx, k.event, p, *k.desktop)
		}
	}
	return send
}
