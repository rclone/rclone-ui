package bustest

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
)

const waitLimit = 30 * time.Second

type Recorder struct {
	t      testing.TB
	sub    *bus.Sub
	mu     sync.Mutex
	events []bus.Event
	closed bool
}

func Record(t testing.TB, b *bus.Bus) *Recorder {
	r := &Recorder{t: t, sub: b.Subscribe()}
	t.Cleanup(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		r.sub.Close()
	})
	return r
}

func (r *Recorder) take() {
	for {
		select {
		case ev, ok := <-r.sub.C:
			if !ok {
				if !r.closed {
					r.closed = true
					r.t.Error("bustest: the bus dropped the recorder, because too many events were published between two reads")
				}
				return
			}
			r.events = append(r.events, ev)
		default:
			return
		}
	}
}

func (r *Recorder) Events() []bus.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.take()
	return slices.Clone(r.events)
}

func (r *Recorder) Named(name string) []bus.Event {
	var out []bus.Event
	for _, ev := range r.Events() {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

// Wait returns the first event, past or future, for which match returns true. It is for an event
// that another goroutine publishes. It fails the test if none arrives.
func (r *Recorder) Wait(what string, match func(bus.Event) bool) bus.Event {
	r.t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.take()
	for _, ev := range r.events {
		if match(ev) {
			return ev
		}
	}
	limit := time.After(waitLimit)
	for {
		select {
		case ev, ok := <-r.sub.C:
			if !ok {
				r.t.Fatalf("bustest: the subscription closed while waiting for %s", what)
			}
			r.events = append(r.events, ev)
			if match(ev) {
				return ev
			}
		case <-limit:
			r.t.Fatalf("bustest: %s was never published", what)
		}
	}
}
