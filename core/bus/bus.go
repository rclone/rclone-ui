// Package bus is the core's in-process event bus. Services publish what changed, and the shell
// passes each event on to the windows so the pages know what to refetch. Events are not stored.
// A subscriber that falls behind is told to read again what it shows (Resync).
package bus

import "sync"

type Event struct {
	Name string
	Data any
}

// buffer is how many events a subscriber can fall behind before it is dropped.
const buffer = 256

// Bus sends each event to all of its subscribers. Publish never blocks. A subscriber that cannot
// keep up is closed instead, and Core.Subscribe then subscribes again and sends Resync.
type Bus struct {
	mu   sync.Mutex
	subs map[*Sub]struct{}
	// heard is closed by the first call to Subscribe.
	heard     chan struct{}
	heardOnce sync.Once
}

func New() *Bus {
	return &Bus{subs: map[*Sub]struct{}{}, heard: make(chan struct{})}
}

// Heard returns a channel that is closed once anything has subscribed. An event published before
// then reaches nobody. So anything the core finds while it starts, before the UI subscribes, must
// wait for this channel if the user needs to see it.
func (b *Bus) Heard() <-chan struct{} { return b.heard }

// Sub is one subscriber. C is closed when the subscriber is closed, either by Close or because it
// fell behind.
type Sub struct {
	C   <-chan Event
	c   chan Event
	bus *Bus
}

// Subscribe adds a subscriber. The app has one user, so every subscriber gets every event.
func (b *Bus) Subscribe() *Sub {
	c := make(chan Event, buffer)
	s := &Sub{C: c, c: c, bus: b}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	b.heardOnce.Do(func() { close(b.heard) })
	return s
}

// Close removes the subscriber and closes C. Closing twice is harmless.
func (s *Sub) Close() {
	s.bus.mu.Lock()
	defer s.bus.mu.Unlock()
	s.bus.drop(s)
}

// drop removes s and closes its channel. The caller must hold b.mu.
func (b *Bus) drop(s *Sub) {
	if _, ok := b.subs[s]; ok {
		delete(b.subs, s)
		close(s.c)
	}
}

func (b *Bus) Publish(name string, data any) {
	ev := Event{Name: name, Data: data}
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		select {
		case s.c <- ev:
		default:
			b.drop(s)
		}
	}
}
