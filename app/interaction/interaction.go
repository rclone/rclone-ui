// Package interaction asks the user questions with native dialogs. It shows messages and
// questions with the app's own button labels (such as Relaunch/Exit or Quit/Cancel), and a prompt
// for text or a password. Every call blocks until the user answers, so it must never be made from
// the main thread. The one exception is ShowPlain on Windows, for when Wails itself failed.
package interaction

import (
	"sync/atomic"

	"github.com/rclone/rclone-ui/core/i18n"
)

// Kind is the dialog's icon.
type Kind string

const (
	Info     Kind = "info"
	Warning  Kind = "warning"
	Error    Kind = "error"
	Question Kind = "question"
)

type Dialog struct {
	Kind    Kind
	Title   string
	Message string
	// OK is the default button ("OK", in the app's language, when empty).
	OK string
	// Cancel is the button that Escape and closing the dialog choose. When it is empty there is no
	// Cancel button, and closing the dialog chooses OK.
	Cancel string
	// Extra is an optional third button.
	Extra string
}

// Answer is the chosen button.
type Answer int

const (
	AnswerOK Answer = iota
	AnswerCancel
	AnswerExtra
)

// open counts the dialogs and prompts that are showing.
var open atomic.Int32

// Open reports whether a dialog or a prompt is showing. On Windows, a window that is put on top
// while one shows would cover it, so the Startup window stays an ordinary window then.
func Open() bool { return open.Load() > 0 }

// showing counts a dialog or a prompt while it shows. Call the function it returns once it closes.
func showing() (closed func()) {
	open.Add(1)
	return func() { open.Add(-1) }
}

func Show(d Dialog) Answer { return present(d, show) }

// present fills in d's defaults, then shows it with display and waits for the answer. A dev
// build's script may answer instead.
func present(d Dialog, display func(Dialog) Answer) Answer {
	if d.OK == "" {
		// i18n: The default button of a dialog that only informs.
		d.OK = i18n.T("OK")
	}
	if d.Kind == "" {
		d.Kind = Info
	}
	if a, _, ok := scripted(d, false); ok {
		return a
	}
	defer showing()()
	return display(d)
}

// Ask shows a question with an OK and a Cancel button. It returns true for OK.
func Ask(kind Kind, title, message, ok, cancel string) bool {
	return Show(Dialog{Kind: kind, Title: title, Message: message, OK: ok, Cancel: cancel}) == AnswerOK
}

func Message(kind Kind, title, message string) {
	Show(Dialog{Kind: kind, Title: title, Message: message})
}

// Prompt asks for a line of text, and sensitive hides what is typed. ok is false when the user
// cancelled. On Linux it is a GTK 4 window of the app's own, inside the process. macOS uses
// osascript, and Windows uses a Win32 dialog.
func Prompt(title, message, def string, sensitive bool) (value string, ok bool, err error) {
	if a, text, ok := scripted(Dialog{Kind: Question, Title: title, Message: message}, true); ok {
		return text, a == AnswerOK, nil
	}
	defer showing()()
	return prompt(title, message, def, sensitive)
}
