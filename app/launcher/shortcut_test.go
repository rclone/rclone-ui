package launcher

import (
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

// fakeBinder registers every accelerator except those in refuse.
type fakeBinder struct {
	refuse map[string]bool
	held   map[string]bool
}

func (b *fakeBinder) register(accel string, _ func(string)) error {
	if b.refuse[accel] {
		return errors.New("taken")
	}
	b.held[accel] = true
	return nil
}

func (b *fakeBinder) unregister(accel string) error {
	delete(b.held, accel)
	return nil
}

// TestShortcutRefused: a refused shortcut leaves the previous one in place. When the previous one
// can't be restored either, none is held and the error says so.
func TestShortcutRefused(t *testing.T) {
	b := &fakeBinder{refuse: map[string]bool{}, held: map[string]bool{}}
	s := &Shortcut{log: slog.New(slog.NewTextHandler(io.Discard, nil)), fn: func(string) {}, bind: b}
	if err := s.Set("Ctrl+Alt+K"); err != nil || s.held != "Ctrl+Alt+k" {
		t.Fatalf("set: %v, held %q", err, s.held)
	}
	b.refuse["Ctrl+Alt+j"] = true
	if err := s.Set("Ctrl+Alt+J"); err == nil || s.held != "Ctrl+Alt+k" || !b.held["Ctrl+Alt+k"] {
		t.Fatalf("refused: %v, held %q, registered %v", err, s.held, b.held)
	}
	b.refuse["Ctrl+Alt+k"] = true
	err := s.Set("Ctrl+Alt+J")
	if err == nil || !strings.Contains(err.Error(), "previous shortcut") {
		t.Errorf("neither: %v", err)
	}
	if s.held != "" || len(b.held) != 0 {
		t.Errorf("neither: held %q, registered %v", s.held, b.held)
	}
	delete(b.refuse, "Ctrl+Alt+k")
	if err := s.Set("Ctrl+Alt+K"); err != nil || !b.held["Ctrl+Alt+k"] {
		t.Errorf("set again: %v, registered %v", err, b.held)
	}
}

func TestAccelerator(t *testing.T) {
	cases := map[string]string{
		"CmdOrCtrl+Shift+/":         "CmdOrCtrl+Shift+/",
		"CommandOrControl+Shift+/":  "CmdOrCtrl+Shift+/",
		"Command+Shift+/":           "Super+Shift+/",
		"Ctrl+Alt+K":                "Ctrl+Alt+k",
		"Shift+F5":                  "Shift+f5",
		"Command+ArrowUp":           "Super+up",
		"Ctrl+Space":                "Ctrl+space",
		"Alt+PageDown":              "Alt+page down",
		"Ctrl+Shift+KeyA":           "Ctrl+Shift+a",
		"Ctrl+Digit1":               "Ctrl+1",
		"Ctrl+Slash":                "Ctrl+/",
		"Ctrl++":                    "Ctrl+plus",
		"Ctrl+Plus":                 "Ctrl+plus",
		"Control+Option+Escape":     "Ctrl+Alt+escape",
		" Shift + Command + Enter ": "Shift+Super+enter",
		"Command+Ctrl+Command+`":    "Super+Ctrl+`",
		"Meta+F12":                  "Super+f12",
	}
	for in, want := range cases {
		got, err := Accelerator(in)
		if err != nil || got != want {
			t.Errorf("Accelerator(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "K", "Hyper+K", "Ctrl+", "Ctrl+Nope", "Ctrl+F99x"} {
		if got, err := Accelerator(bad); err == nil {
			t.Errorf("Accelerator(%q) = %q, want an error", bad, got)
		}
	}
}
