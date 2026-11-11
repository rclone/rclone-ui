//go:build linux

package launcher

// Adapted from Wails v3.1.0 pkg/application/global_shortcut_linux_portal.go (MIT). It
// uses the same GlobalShortcuts session, for the launcher's single shortcut, but keeps something
// that Wails drops: the activation token sent with each key press (xdg-desktop-portal 1.21).
// That token is the only thing that lets a Wayland window take the focus.

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// newBinder returns Wails' global shortcuts on X11 (a key grab), and the launcher's own portal
// session on Wayland.
func newBinder(app *application.App, log *slog.Logger) binder {
	if waylandSession(os.Getenv) {
		return &portalBinder{log: log, want: make(chan *binding, 1)}
	}
	return wailsBinder{app}
}

const (
	portalService   = "org.freedesktop.portal.Desktop"
	portalPath      = dbus.ObjectPath("/org/freedesktop/portal/desktop")
	portalShortcuts = "org.freedesktop.portal.GlobalShortcuts"
	portalRequest   = "org.freedesktop.portal.Request"
	portalSession   = "org.freedesktop.portal.Session"
	shortcutID      = "launcher"
	// portalWait is how long a portal request may take. Binding may wait for the user to answer
	// a dialog shown by the desktop.
	portalWait = 5 * time.Minute
	// answerWait is how long register waits for the portal's answer. A portal without global
	// shortcuts, or one that refuses outright, answers well within this time. A desktop that asks
	// the user may not, and startup shouldn't wait for the user.
	answerWait = 2 * time.Second
)

// portalBinder binds the launcher's shortcut through xdg-desktop-portal's GlobalShortcuts. The
// portal answers asynchronously and may ask the user, so register queues the binding (the latest
// request wins) and waits up to answerWait for the portal's answer. A refusal within that time
// is returned as register's error, so Settings never saves a shortcut that the desktop refused.
// A later refusal is only logged. The trigger is only a preference, because the desktop and the
// user decide the actual keys.
type portalBinder struct {
	log  *slog.Logger
	want chan *binding // holds at most one binding: the latest one requested
	once sync.Once

	mu sync.Mutex
	fn func(token string)
}

// binding is an accelerator to bind ("" for none) and the channel that receives the portal's
// answer.
type binding struct {
	accel string
	done  chan error // buffered, and answered once
}

func newBinding(accel string) *binding { return &binding{accel: accel, done: make(chan error, 1)} }

// answer sends the binding's outcome. It does nothing for a nil binding or one that was already
// answered.
func (r *binding) answer(err error) {
	if r == nil || r.done == nil {
		return
	}
	r.done <- err
	r.done = nil
}

func (b *portalBinder) register(accel string, fn func(token string)) error {
	b.mu.Lock()
	b.fn = fn
	b.mu.Unlock()
	r := newBinding(accel)
	done := r.done
	b.queue(r)
	select {
	case err := <-done:
		return err
	case <-time.After(answerWait):
		b.log.Info("launcher shortcut: the portal hasn't answered yet", "shortcut", accel)
		return nil
	}
}

func (b *portalBinder) unregister(string) error {
	b.queue(newBinding(""))
	return nil
}

// queue replaces the binding that is waiting with r. The replaced binding is no longer wanted,
// so it is answered with nil rather than a refusal.
func (b *portalBinder) queue(r *binding) {
	b.once.Do(func() { go b.run() })
	for {
		select {
		case b.want <- r:
			return
		default:
			select {
			case stale := <-b.want:
				stale.answer(nil)
			default:
			}
		}
	}
}

// fire handles a key press by calling the shortcut's function, with the activation token when the
// portal sends one.
func (b *portalBinder) fire(options map[string]dbus.Variant) {
	token := ""
	if v, ok := options["activation_token"]; ok {
		token, _ = v.Value().(string)
	}
	b.mu.Lock()
	fn := b.fn
	b.mu.Unlock()
	if fn != nil {
		fn(token)
	}
}

// run owns the D-Bus connection and the portal session for the life of the process, and answers
// each binding. Bindings requested in quick succession (a release, then the new shortcut) are
// combined into one.
func (b *portalBinder) run() {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		b.log.Error("launcher shortcut: no session bus", "error", err)
		err = fmt.Errorf("no session bus: %w", err)
		for r := range b.want {
			if r.accel == "" {
				r.answer(nil)
			} else {
				r.answer(err)
			}
		}
		return
	}
	defer func() { _ = conn.Close() }()
	p := &portal{conn: conn, pending: map[dbus.ObjectPath]chan portalResponse{}}
	if names := conn.Names(); len(names) > 0 {
		p.sender = strings.ReplaceAll(strings.TrimPrefix(names[0], ":"), ".", "_")
	}
	// Responses and key presses arrive on one channel. It is read on its own goroutine, separate
	// from the calls that wait for responses.
	sigs := make(chan *dbus.Signal, 32)
	conn.Signal(sigs)
	_ = conn.AddMatchSignal(dbus.WithMatchInterface(portalRequest), dbus.WithMatchMember("Response"))
	_ = conn.AddMatchSignal(dbus.WithMatchInterface(portalShortcuts), dbus.WithMatchMember("Activated"))
	go func() {
		for sig := range sigs {
			p.signal(sig, b.fire)
		}
	}()

	var session dbus.ObjectPath
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	var next *binding
	for {
		select {
		case r := <-b.want:
			next.answer(nil) // replaced before it was bound
			next = r
			debounce.Reset(150 * time.Millisecond)
		case <-debounce.C:
			if session != "" {
				p.close(session)
				session = ""
			}
			if next == nil || next.accel == "" {
				next.answer(nil)
				continue
			}
			s, err := p.createSession()
			if err != nil {
				b.log.Error("launcher shortcut: the desktop's portal has no global shortcuts", "error", err)
				next.answer(errs.Errorf("the desktop's portal has no global shortcuts: %w", err))
				continue
			}
			session = s
			trigger := portalTrigger(next.accel)
			if err := p.bind(session, trigger); err != nil {
				b.log.Error("launcher shortcut: not bound", "shortcut", next.accel, "error", err)
				// i18n: %s is a keyboard shortcut, in the desktop's syntax.
				next.answer(errs.Errorf("the desktop didn't bind %s: %w", trigger, err))
				continue
			}
			b.log.Info("launcher shortcut bound by the portal", "trigger", trigger)
			next.answer(nil)
		}
	}
}

type portalResponse struct {
	code    uint32 // 0 granted, 1 cancelled by the user, 2 ended
	results map[string]dbus.Variant
}

// portal makes the GlobalShortcuts calls, which follow the portal's Request/Response pattern.
type portal struct {
	conn   *dbus.Conn
	sender string // the connection's unique name, in the form used in request paths
	seq    int

	mu      sync.Mutex
	pending map[dbus.ObjectPath]chan portalResponse
}

func (p *portal) token(prefix string) string {
	p.seq++
	return fmt.Sprintf("rcui_%s_%d", prefix, p.seq)
}

// call invokes a portal method and waits for its Response. The request's path is known before
// the call (from handle_token), so a Response that arrives before the call returns isn't missed.
func (p *portal) call(method string, options map[string]dbus.Variant, args ...any) (portalResponse, error) {
	token := p.token("req")
	options["handle_token"] = dbus.MakeVariant(token)
	expected := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + p.sender + "/" + token)
	ch := make(chan portalResponse, 1)
	p.wait(expected, ch)
	defer p.forget(expected)
	var handle dbus.ObjectPath
	if err := p.conn.Object(portalService, portalPath).Call(portalShortcuts+"."+method, 0,
		append(args, options)...).Store(&handle); err != nil {
		return portalResponse{}, err
	}
	if handle != expected { // older portals choose the request path themselves
		p.wait(handle, ch)
		defer p.forget(handle)
	}
	select {
	case r := <-ch:
		return r, nil
	case <-time.After(portalWait):
		return portalResponse{}, fmt.Errorf("no answer to %s", method)
	}
}

func (p *portal) wait(path dbus.ObjectPath, ch chan portalResponse) {
	p.mu.Lock()
	p.pending[path] = ch
	p.mu.Unlock()
}

func (p *portal) forget(path dbus.ObjectPath) {
	p.mu.Lock()
	delete(p.pending, path)
	p.mu.Unlock()
}

func (p *portal) createSession() (dbus.ObjectPath, error) {
	r, err := p.call("CreateSession", map[string]dbus.Variant{"session_handle_token": dbus.MakeVariant(p.token("session"))})
	if err != nil {
		return "", err
	}
	if r.code != 0 {
		return "", fmt.Errorf("CreateSession refused (response %d)", r.code)
	}
	// The spec says "s", but some portals send an object path.
	switch v := r.results["session_handle"].Value().(type) {
	case string:
		return dbus.ObjectPath(v), nil
	case dbus.ObjectPath:
		return v, nil
	}
	return "", fmt.Errorf("CreateSession gave no session")
}

// bind requests the launcher's shortcut in session, with trigger as its preferred keys.
func (p *portal) bind(session dbus.ObjectPath, trigger string) error {
	type shortcut struct {
		ID    string
		Props map[string]dbus.Variant
	}
	list := []shortcut{{ID: shortcutID, Props: map[string]dbus.Variant{
		// i18n: The description of the launcher's shortcut, which the desktop shows in its keyboard settings.
		"description":       dbus.MakeVariant(i18n.T("Open the Rclone UI launcher")),
		"preferred_trigger": dbus.MakeVariant(trigger),
	}}}
	r, err := p.call("BindShortcuts", map[string]dbus.Variant{}, session, list, "")
	if err != nil {
		return err
	}
	if r.code != 0 {
		return fmt.Errorf("the portal didn't grant it (response %d)", r.code)
	}
	return nil
}

// close ends session, which also removes its binding.
func (p *portal) close(session dbus.ObjectPath) {
	_ = p.conn.Object(portalService, session).Call(portalSession+".Close", 0).Err
}

// signal sends a Response to the call that is waiting for it, and sends a press of the
// launcher's shortcut to fire. The press arrives as Activated(o session, s id, t timestamp,
// a{sv} options).
func (p *portal) signal(sig *dbus.Signal, fire func(map[string]dbus.Variant)) {
	switch {
	case strings.HasSuffix(sig.Name, ".Response"):
		p.mu.Lock()
		ch, ok := p.pending[sig.Path]
		p.mu.Unlock()
		if !ok {
			return
		}
		var r portalResponse
		if len(sig.Body) >= 1 {
			r.code, _ = sig.Body[0].(uint32)
		}
		if len(sig.Body) >= 2 {
			r.results, _ = sig.Body[1].(map[string]dbus.Variant)
		}
		select {
		case ch <- r:
		default:
		}
	case strings.HasSuffix(sig.Name, ".Activated"):
		if len(sig.Body) < 2 {
			return
		}
		if id, _ := sig.Body[1].(string); id != shortcutID {
			return
		}
		options := map[string]dbus.Variant{}
		if len(sig.Body) >= 4 {
			if o, ok := sig.Body[3].(map[string]dbus.Variant); ok {
				options = o
			}
		}
		fire(options)
	}
}
