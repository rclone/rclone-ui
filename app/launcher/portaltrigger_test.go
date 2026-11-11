package launcher

import "testing"

// TestPortalTrigger: shortcuts from Settings, converted by Accelerator, become the portal's
// preferred triggers.
func TestPortalTrigger(t *testing.T) {
	for _, c := range []struct{ shortcut, want string }{
		{DefaultShortcut, "CTRL+SHIFT+slash"},
		{"Ctrl+Alt+K", "CTRL+ALT+k"},
		{"Command+Shift+Space", "SHIFT+LOGO+space"},
		{"Alt+F5", "ALT+F5"},
		{"CmdOrCtrl+Shift+ArrowUp", "CTRL+SHIFT+Up"},
		{"Ctrl++", "CTRL+plus"},
		{"Shift+Alt+Digit1", "ALT+SHIFT+1"},
	} {
		acc, err := Accelerator(c.shortcut)
		if err != nil {
			t.Fatalf("%s: %v", c.shortcut, err)
		}
		if got := portalTrigger(acc); got != c.want {
			t.Errorf("%s (%s): got %q, want %q", c.shortcut, acc, got, c.want)
		}
	}
}

func TestWaylandSession(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		want bool
	}{
		{map[string]string{"XDG_SESSION_TYPE": "wayland"}, true},
		{map[string]string{"XDG_SESSION_TYPE": "x11", "WAYLAND_DISPLAY": "wayland-0"}, false},
		{map[string]string{"WAYLAND_DISPLAY": "wayland-0"}, true},
		{map[string]string{}, false},
	} {
		if got := waylandSession(func(k string) string { return c.env[k] }); got != c.want {
			t.Errorf("%v: got %v", c.env, got)
		}
	}
}
