package children

import (
	"errors"

	"github.com/rclone/rclone-ui/core/i18n"
)

var errNoProcess = errors.New("no such process")

// textError is an error whose message is a translatable text. The core keeps why a child went
// down as an error, and a page shows it in the app's language (i18n.Localize).
type textError struct {
	text i18n.Text
	err  error
}

func (e *textError) Error() string   { return e.text.String() }
func (e *textError) Text() i18n.Text { return e.text }
func (e *textError) Unwrap() error   { return e.err }

// TextError returns an error whose message is text, made with i18n.M. wrapped, when it isn't
// nil, is the error that text quotes, which errors.Is and errors.As still find. It is for an
// error that explains why a child went down, rather than one that refuses a request (core/errs).
func TextError(text i18n.Text, wrapped error) error { return &textError{text: text, err: wrapped} }
