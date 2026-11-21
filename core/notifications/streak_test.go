package notifications

import (
	"context"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu      sync.Mutex
	sent    []NotificationEvent
	desktop []Desktop
}

func (r *recorder) Notify(_ context.Context, event NotificationEvent, _ Payload) {
	r.mu.Lock()
	r.sent = append(r.sent, event)
	r.mu.Unlock()
}

func (r *recorder) Desktop(_ context.Context, _ NotificationEvent, _ Payload, d Desktop) {
	r.mu.Lock()
	r.desktop = append(r.desktop, d)
	r.mu.Unlock()
}

func TestStreak(t *testing.T) {
	type step struct {
		after time.Duration // how far the clock moves first
		up    bool          // call Up, or else Failed
		sent  bool          // what Failed returns
	}
	failed := func(after time.Duration, sent bool) step { return step{after: after, sent: sent} }
	up := func(after time.Duration) step { return step{after: after, up: true} }
	for _, c := range []struct {
		name  string
		steps []step
	}{
		{"the first failure is news", []step{failed(0, true)}},
		{"a crash loop says it once", []step{failed(0, true), failed(time.Second, false), up(time.Second),
			failed(10*time.Second, false), up(time.Minute), failed(4*time.Minute, false)}},
		{"down for long is still the same streak", []step{failed(0, true), failed(time.Hour, false), failed(time.Hour, false)}},
		{"up five minutes ends the streak", []step{failed(0, true), up(time.Second), failed(StreakEnd, true),
			failed(time.Second, false)}},
		{"up just under five minutes does not", []step{failed(0, true), up(0), failed(StreakEnd-time.Second, false)}},
		{"only the last stretch up counts", []step{failed(0, true), up(0), failed(4*time.Minute, false), up(0),
			failed(4*time.Minute, false), up(0), failed(5*time.Minute, true)}},
		{"up first, then a failure", []step{up(0), failed(time.Hour, true)}},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := &recorder{}
			now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			k := NewStreak(r, NotificationEventMountFailed, nil)
			k.now = func() time.Time { return now }
			want := 0
			for i, s := range c.steps {
				now = now.Add(s.after)
				if s.up {
					k.Up()
					continue
				}
				if got := k.Failed(context.Background(), MountFailed{}); got != s.sent {
					t.Fatalf("step %d: Failed = %v, want %v", i, got, s.sent)
				}
				if s.sent {
					want++
				}
			}
			if len(r.sent) != want {
				t.Fatalf("sent %d, want %d", len(r.sent), want)
			}
			for _, e := range r.sent {
				if e != NotificationEventMountFailed {
					t.Errorf("sent %s", e)
				}
			}
			if len(r.desktop) != 0 {
				t.Errorf("shown on the desktop %+v", r.desktop)
			}
		})
	}
}

// A streak with a desktop shows each event that it sends on the desktop too, and nothing more.
func TestStreakDesktop(t *testing.T) {
	r := &recorder{}
	k := NewStreak(r, NotificationEventWatcherFailed, &Desktop{Route: "/watchers"})
	for range 3 {
		k.Failed(context.Background(), WatcherFailed{Name: "Docs"})
	}
	if len(r.sent) != 1 || len(r.desktop) != 1 || r.desktop[0] != (Desktop{Route: "/watchers"}) {
		t.Errorf("sent %v, desktop %+v", r.sent, r.desktop)
	}
}
