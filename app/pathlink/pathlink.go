// Package pathlink implements "Add rclone to PATH". It adds a command named rclone that runs rcui,
// which acts as rclone when called by that name and uses the same config files as the app. It is
// opt-in, it never replaces a user's own rclone, and it updates with the app because it points to
// the app. The link lives in these places:
//
//   - macOS: /usr/local/bin/rclone → <data>/bin/rclone → the app's rcui. /usr/local/bin usually
//     needs an administrator password, but the pointer in <data> doesn't, so the app can follow a
//     moved bundle without asking again.
//   - Linux: ~/.local/bin/rclone → <data>/bin/rclone → /usr/bin/rcui or $APPIMAGE.
//   - Windows: the bin folder next to rcui.exe is added to the user's PATH. It holds the
//     rclone.exe that the installer and the portable zip bring, a console program that runs
//     rcui.exe (see build/windows/rclone-shim).
//
// The package doesn't import Wails. The UI role's PathService binds it for pages.
package pathlink

import (
	"errors"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

type State struct {
	// Supported is false where no link can work (Flatpak, or a Windows copy without
	// bin\rclone.exe). Reason explains why. Reason and Warning are in the app's language.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	// Enabled means that `rclone` in a new terminal runs this app's rclone, unless Warning says
	// that another rclone comes first.
	Enabled bool `json:"enabled"`
	// Link is where the command is placed (/usr/local/bin/rclone, ~/.local/bin/rclone, or the
	// folder added to PATH on Windows). Target is the program it runs.
	Link   string `json:"link,omitempty"`
	Target string `json:"target,omitempty"`
	// UserRclone is another rclone found on PATH. It is the user's own, and it is never replaced.
	UserRclone string `json:"userRclone,omitempty"`
	// Warning explains why an enabled link may not work as expected.
	Warning string `json:"warning,omitempty"`
	// NeedsAdmin means that Enable and Disable ask for an administrator password (macOS).
	NeedsAdmin bool `json:"needsAdmin"`
	// Command is what a terminal runs to use this app's rclone, as in `<Command> tunnel`. It is
	// "rclone" when the link works, or else the app's own program, quoted for the OS's usual
	// shell.
	Command string `json:"command,omitempty"`
}

// Errors that Enable returns, which errors.Is finds. The error itself says more, in words that
// the page shows in the app's language (see refusal).
var (
	// ErrUnsupported means no link can work here. State.Reason explains why.
	ErrUnsupported = errors.New("adding rclone to PATH isn't possible here")
	// ErrForeign means that a file that doesn't belong to this app already has the link's name.
	ErrForeign = errors.New("an rclone that isn't Rclone UI's is already there")
)

// refusal is an error that the page shows (shown, made with core/errs, so that the page gets it
// in the app's language) and that errors.Is matches with kind (ErrUnsupported, ErrForeign).
type refusal struct{ shown, kind error }

func (r refusal) Error() string   { return r.shown.Error() }
func (r refusal) Unwrap() []error { return []error{r.shown, r.kind} }

func unsupported(reason i18n.Text) error {
	return refusal{errs.Said(errs.CodeUnsupported, reason), ErrUnsupported}
}

func Status() (State, error) {
	l, err := New()
	if err != nil {
		return State{}, err
	}
	return l.Status(), nil
}

func Enable() (State, error) {
	l, err := New()
	if err != nil {
		return State{}, err
	}
	return l.Enable()
}

func Disable() (State, error) {
	l, err := New()
	if err != nil {
		return State{}, err
	}
	return l.Disable()
}

// Refresh keeps an enabled link pointing to this copy of the app. The UI calls it once at start,
// so the link follows a moved app.
func Refresh() error {
	l, err := New()
	if err != nil {
		return err
	}
	return l.Refresh()
}
