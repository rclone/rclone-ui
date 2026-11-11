// Package telemetry sends the app's anonymous usage data and crash reports to PostHog, when the
// user shares them (settings.Telemetry). It is the only place in the app that sends any. The
// pages send nothing themselves: they call the API here, which takes named events only.
//
// What is sent is kept apart from what the user has:
//   - An event is a name from a fixed list with a few properties: an operation's kind, a backend's
//     type, a count, a duration. Never a path, a file's name, a remote's name or an option's value.
//   - A crash report is an error's kind, its message and its stack. The message goes through
//     Scrub, which takes out paths, addresses, quoted text and the remotes' names.
//   - Everything is sent under a random id (settings.Telemetry.ID) that names no person and no
//     computer, and without the sender's location.
//
// Nothing is sent by a build without a key (Key), when DO_NOT_TRACK is set, or while the user has
// it turned off.
package telemetry

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/posthog/posthog-go"

	"github.com/rclone/rclone-ui/core/settings"
)

// Host is where the data goes: PostHog Cloud, US.
const Host = "https://us.i.posthog.com"

const (
	// closeWait is how long a quit waits for the last events to be sent.
	closeWait = 2 * time.Second
	// exceptionsMax is the most crash reports sent in one run, so an error that repeats can't
	// flood.
	exceptionsMax = 25
)

type Options struct {
	// Key is the PostHog project key. "" means the build's own (Key), and a build without one
	// sends nothing.
	Key string
	// Host is where the data goes. "" means Host.
	Host string
	// Transport makes the requests, through the app's proxy. nil means Go's default.
	Transport http.RoundTripper
	// DoNotTrack is set when the environment has DO_NOT_TRACK, which turns everything off.
	DoNotTrack bool
	// Props returns what is sent with every event: the app's version, the language. The client
	// adds the OS and its version.
	Props func() map[string]any
	// Names returns the remotes' names, which Scrub takes out of every message.
	Names func() []string
	// Started is called once in each run, the first time that data may be sent. It sends what
	// describes the run (the app_started event).
	Started func()
	Log     *slog.Logger
}

type Service struct {
	o       Options
	session string

	mu      sync.Mutex
	client  posthog.Client // nil until data may be sent
	id      string
	started bool
	closed  bool
	// reported holds the crash reports sent in this run, by fingerprint, so each is sent once.
	reported map[string]bool

	// active is whether data may be sent now. The client's requests read it (gate).
	active atomic.Bool
}

// New returns a service that sends nothing until Apply allows it.
func New(o Options) *Service {
	if o.Key == "" {
		o.Key = buildKey()
	}
	if o.Host == "" {
		o.Host = buildHost()
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	// PostHog groups events into sessions by a time-ordered id. One run of the app is one.
	session := uuid.NewString()
	if v7, err := uuid.NewV7(); err == nil {
		session = v7.String()
	}
	return &Service{o: o, session: session, reported: map[string]bool{}}
}

// Info is what the Settings page shows about sharing, beyond the user's own switch.
type Info struct {
	// Built is false in a build without a key, which sends nothing whatever the switch says.
	Built bool `json:"built"`
	// DoNotTrack is true when DO_NOT_TRACK is set in the environment, which turns sharing off.
	DoNotTrack bool `json:"doNotTrack"`
}

func (s *Service) Info() Info { return Info{Built: s.o.Key != "", DoNotTrack: s.o.DoNotTrack} }

func (s *Service) allowed(st settings.Telemetry) bool {
	return s.o.Key != "" && !s.o.DoNotTrack && st.Enabled && st.ID != ""
}

// Apply follows the user's choice: it starts sending when st allows it, under st's id, and stops
// when it doesn't. The core calls it at the start and after every change of the settings.
func (s *Service) Apply(st settings.Telemetry) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if !s.allowed(st) {
		s.active.Store(false)
		s.id = ""
		s.mu.Unlock()
		return
	}
	s.id = st.ID
	if s.client == nil {
		client, err := posthog.NewWithConfig(s.o.Key, posthog.Config{
			Endpoint:        s.o.Host,
			Transport:       gate{s},
			IsServer:        posthog.Ptr(false),
			DisableGeoIP:    posthog.Ptr(true),
			ShutdownTimeout: closeWait,
			Logger:          quiet{s.o.Log},
		})
		if err != nil {
			s.o.Log.Warn("telemetry is off", "error", err)
			s.mu.Unlock()
			return
		}
		s.client = client
	}
	s.active.Store(true)
	first := !s.started
	s.started = true
	s.mu.Unlock()
	if first && s.o.Started != nil {
		s.o.Started()
	}
}

// Close sends what is waiting, for a short while, and stops.
func (s *Service) Close() {
	s.mu.Lock()
	client := s.client
	s.client, s.closed = nil, true
	s.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	s.active.Store(false)
}

// Flush sends what is waiting now, without waiting for the client's own beat.
func (s *Service) Flush() {
	if client, _ := s.current(); client != nil {
		_ = client.Flush()
	}
}

// current returns the client and the id to send under, or nil when nothing may be sent.
func (s *Service) current() (posthog.Client, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active.Load() || s.client == nil {
		return nil, ""
	}
	return s.client, s.id
}

// properties returns props with what every event carries. No person is kept for the id: PostHog
// stores the events only.
func (s *Service) properties(props map[string]any) posthog.Properties {
	out := posthog.NewProperties()
	if s.o.Props != nil {
		for k, v := range s.o.Props() {
			out.Set(k, v)
		}
	}
	for k, v := range props {
		out.Set(k, v)
	}
	return out.Set("$session_id", s.session).Set("$process_person_profile", false)
}

// Capture sends the event name with props. The core's own code calls it, and is trusted to pass
// nothing of the user's: no path, no name. A page's events go through Track.
func (s *Service) Capture(name string, props map[string]any) {
	client, id := s.current()
	if client == nil {
		return
	}
	_ = client.Enqueue(posthog.Capture{DistinctId: id, Event: name, Properties: s.properties(props)})
}

// Screen records that a window opened, by its fixed name ("Commander").
func (s *Service) Screen(window string) {
	s.Capture("$screen", map[string]any{"$screen_name": window})
}

// Crash is an error to report: a panic, a crash of the app, or a page's error.
type Crash struct {
	// Kind is the error's kind, which names the report ("panic", "TypeError").
	Kind string
	// Message says what went wrong. It is scrubbed before it is sent.
	Message string
	Frames  []Frame
	// Handled is false for an error that ended the app or the page.
	Handled bool
	// Source is where it happened: "core", "app", "crash" for a crash found in crash.log, or
	// "page".
	Source string
	// Window is the page's window, for a page's error.
	Window string
	// At is when it happened. The zero time means now.
	At time.Time
}

// Frame is one call in a stack, innermost last.
type Frame struct {
	Function string
	File     string
	Line     int
	// Script marks a frame of a page's JavaScript.
	Script bool
}

// Report sends a crash report. Each distinct error is sent once in a run, and at most
// exceptionsMax in all.
func (s *Service) Report(c Crash) {
	client, id := s.current()
	if client == nil {
		return
	}
	c.Message = s.Scrub(c.Message)
	print := fingerprint(c)
	s.mu.Lock()
	if s.reported[print] || len(s.reported) >= exceptionsMax {
		s.mu.Unlock()
		return
	}
	s.reported[print] = true
	s.mu.Unlock()

	frames := make([]posthog.StackFrame, len(c.Frames))
	for i, f := range c.Frames {
		platform := "go"
		if f.Script {
			platform = "web:javascript"
		}
		frames[i] = posthog.StackFrame{
			Filename: f.File, LineNo: f.Line, Function: f.Function,
			InApp: f.Script || inApp(f.Function), Platform: platform,
		}
	}
	item := posthog.ExceptionItem{
		Type: c.Kind, Value: c.Message,
		Mechanism: &posthog.ExceptionMechanism{Handled: posthog.Ptr(c.Handled), Synthetic: posthog.Ptr(false)},
	}
	if len(frames) > 0 {
		item.Stacktrace = &posthog.ExceptionStacktrace{Type: "raw", Frames: frames}
	}
	props := map[string]any{"source": c.Source}
	if c.Window != "" {
		props["window"] = c.Window
	}
	_ = client.Enqueue(posthog.Exception{
		DistinctId: id, Timestamp: c.At, Properties: s.properties(props),
		ExceptionList: []posthog.ExceptionItem{item},
	})
}

// fingerprint names a crash for this run: its kind, its message and where it happened.
func fingerprint(c Crash) string {
	at := ""
	if n := len(c.Frames); n > 0 {
		at = fmt.Sprintf("%s:%d", c.Frames[n-1].Function, c.Frames[n-1].Line)
	}
	return c.Source + "|" + c.Kind + "|" + c.Message + "|" + at
}

// Panic reports a panic that was recovered, from its value and the stack that debug.Stack gave.
// source is the part of the app that recovered it.
func (s *Service) Panic(source string, v any, stack []byte) {
	s.Report(Crash{
		Kind: "panic", Message: fmt.Sprint(v), Frames: goFrames(string(stack)),
		Handled: true, Source: source,
	})
}

// gate makes the client's requests while data may be sent, and refuses them otherwise. The client
// queues events for a few seconds before it sends them, so this is what keeps an event that was
// still waiting from being sent after the user turned sharing off.
type gate struct{ s *Service }

func (g gate) RoundTrip(r *http.Request) (*http.Response, error) {
	if !g.s.active.Load() {
		return nil, errOff
	}
	rt := g.s.o.Transport
	if rt == nil {
		rt = http.DefaultTransport
	}
	return rt.RoundTrip(r)
}

var errOff = errors.New("telemetry is turned off")

// quiet sends the client's own messages to the app's log at the debug level. Failing to reach
// PostHog is not something the user needs to see.
type quiet struct{ log *slog.Logger }

func (q quiet) Debugf(format string, args ...any) {}
func (q quiet) Logf(format string, args ...any) {
	q.log.Debug("telemetry: " + fmt.Sprintf(format, args...))
}
func (q quiet) Warnf(format string, args ...any) {
	q.log.Debug("telemetry: " + fmt.Sprintf(format, args...))
}
func (q quiet) Errorf(format string, args ...any) {
	q.log.Debug("telemetry: " + fmt.Sprintf(format, args...))
}
