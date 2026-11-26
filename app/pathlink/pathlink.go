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

var (
	ErrUnsupported = errors.New("adding rclone to PATH isn't possible here")
	ErrForeign     = errors.New("an rclone that isn't Rclone UI's is already there")
)

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

// Refresh keeps an enabled link pointing to this copy of the app.
func Refresh() error {
	l, err := New()
	if err != nil {
		return err
	}
	return l.Refresh()
}
