package launcher

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/core/errs"
)

const DefaultShortcut = "CmdOrCtrl+Shift+/"

// Accelerator converts a shortcut from the format stored in the settings into Wails' accelerator
// syntax. The settings use the syntax that the Settings recorder writes ("Command+Shift+/",
// "Ctrl+Alt+K", "CmdOrCtrl+Shift+ArrowUp"). The Wails forms are "Super+Shift+/", "Ctrl+Alt+k" and
// "CmdOrCtrl+Shift+up". Command, Cmd, Meta and Super mean the Command key on macOS and the
// Windows/Super key elsewhere.
func Accelerator(shortcut string) (string, error) {
	s := strings.TrimSpace(shortcut)
	if s == "" {
		return "", errs.New("empty shortcut")
	}
	// "+" can itself be the key, as in "Ctrl++", where it follows the modifier's "+".
	var parts []string
	if before, ok := strings.CutSuffix(s, "++"); ok {
		parts = append(strings.Split(before, "+"), "plus")
	} else {
		parts = strings.Split(s, "+")
	}
	if len(parts) < 2 {
		return "", errs.Errorf("shortcut %q has no modifier", shortcut)
	}
	out := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		mod, ok := modifiers[strings.ToLower(strings.TrimSpace(m))]
		if !ok {
			// i18n: %[1]q is a keyboard shortcut, and %[2]q the part of it that should be a modifier key (Ctrl, Alt, Shift…).
			return "", errs.Errorf("shortcut %[1]q: %[2]q is not a modifier", shortcut, m)
		}
		if !seen[mod] {
			seen[mod] = true
			out = append(out, mod)
		}
	}
	key, err := keyName(strings.TrimSpace(parts[len(parts)-1]))
	if err != nil {
		return "", fmt.Errorf("shortcut %q: %w", shortcut, err)
	}
	return strings.Join(append(out, key), "+"), nil
}

var modifiers = map[string]string{
	"cmdorctrl":        "CmdOrCtrl",
	"commandorcontrol": "CmdOrCtrl",
	"commandorctrl":    "CmdOrCtrl",
	"cmdorcontrol":     "CmdOrCtrl",
	"command":          "Super",
	"cmd":              "Super",
	"meta":             "Super",
	"super":            "Super",
	"control":          "Ctrl",
	"ctrl":             "Ctrl",
	"alt":              "Alt",
	"option":           "Alt",
	"optionoralt":      "Alt",
	"altgr":            "Alt",
	"shift":            "Shift",
}

// keyName converts a key name from the settings' syntax (a character, "Slash", "KeyA", "Digit1",
// "ArrowUp", "F5", …) to Wails' syntax.
func keyName(k string) (string, error) {
	if k == "" {
		return "", errs.New("no key")
	}
	lower := strings.ToLower(k)
	if named, ok := namedKeys[lower]; ok {
		return named, nil
	}
	switch {
	case len(lower) == 4 && strings.HasPrefix(lower, "key") && lower[3] >= 'a' && lower[3] <= 'z':
		return lower[3:], nil
	case len(lower) == 6 && strings.HasPrefix(lower, "digit") && lower[5] >= '0' && lower[5] <= '9':
		return lower[5:], nil
	case len(lower) >= 2 && len(lower) <= 3 && lower[0] == 'f' && isDigits(lower[1:]):
		return lower, nil
	case len([]rune(k)) == 1:
		if k == "+" {
			return "plus", nil
		}
		return lower, nil
	}
	return "", errs.Errorf("%q is not a key", k)
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

var namedKeys = map[string]string{
	"slash":        "/",
	"backslash":    `\`,
	"backquote":    "`",
	"minus":        "-",
	"equal":        "=",
	"bracketleft":  "[",
	"bracketright": "]",
	"semicolon":    ";",
	"quote":        "'",
	"comma":        ",",
	"period":       ".",
	"plus":         "plus",
	"space":        "space",
	"enter":        "enter",
	"return":       "return",
	"tab":          "tab",
	"escape":       "escape",
	"esc":          "escape",
	"backspace":    "backspace",
	"delete":       "delete",
	"home":         "home",
	"end":          "end",
	"pageup":       "page up",
	"pagedown":     "page down",
	"arrowup":      "up",
	"arrowdown":    "down",
	"arrowleft":    "left",
	"arrowright":   "right",
	"up":           "up",
	"down":         "down",
	"left":         "left",
	"right":        "right",
}

// Shortcut is the launcher's global shortcut, which calls fn. fn receives the compositor's
// activation token for the key press when there is one (on Wayland), and "" otherwise.
type Shortcut struct {
	log  *slog.Logger
	fn   func(token string)
	bind binder
	mu   sync.Mutex
	held string // the registered accelerator
}

// binder registers an accelerator with the OS. It uses Wails' global shortcuts, or on Wayland the
// launcher's own portal session (shortcut_linux.go), which passes on the activation token.
type binder interface {
	register(accel string, fn func(token string)) error
	unregister(accel string) error
}

// wailsBinder uses Wails' global shortcuts, which don't provide a token.
type wailsBinder struct{ app *application.App }

func (b wailsBinder) register(accel string, fn func(token string)) error {
	return b.app.GlobalShortcut.Register(accel, func() { fn("") })
}

func (b wailsBinder) unregister(accel string) error { return b.app.GlobalShortcut.Unregister(accel) }

func NewShortcut(app *application.App, log *slog.Logger, fn func(token string)) *Shortcut {
	return &Shortcut{log: log, fn: fn, bind: newBinder(app, log)}
}

// Set replaces the shortcut, and "" removes it. shortcut uses the syntax that Settings
// records. If the OS refuses the new shortcut, the previous one stays in place and Set
// returns the reason. Settings saves a shortcut only after it is registered.
func (s *Shortcut) Set(shortcut string) error {
	next := ""
	if shortcut != "" {
		acc, err := Accelerator(shortcut)
		if err != nil {
			return err
		}
		next = acc
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.held
	if next == prev {
		return nil
	}
	if prev != "" {
		if err := s.bind.unregister(prev); err != nil {
			s.log.Warn("could not release the launcher shortcut", "shortcut", prev, "error", err)
		}
	}
	if next != "" {
		if err := s.bind.register(next, s.fn); err != nil {
			if prev == "" {
				return err
			}
			if rerr := s.bind.register(prev, s.fn); rerr != nil {
				// Neither shortcut is registered now, so none is held, and the error reports
				// both failures.
				s.held = ""
				s.log.Error("could not restore the launcher shortcut", "shortcut", prev, "error", rerr)
				return errs.Errorf("%w (and the previous shortcut could not be restored: %v)", err, rerr)
			}
			return err
		}
	}
	s.held = next
	s.log.Info("launcher shortcut set", "shortcut", shortcut, "accelerator", next)
	return nil
}
