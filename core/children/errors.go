package children

import (
	"errors"

	"github.com/rclone/rclone-ui/core/i18n"
)

var errNoProcess = errors.New("no such process")

type textError struct {
	text i18n.Text
	err  error
}

func (e *textError) Error() string   { return e.text.String() }
func (e *textError) Text() i18n.Text { return e.text }
func (e *textError) Unwrap() error   { return e.err }

func TextError(text i18n.Text, wrapped error) error { return &textError{text: text, err: wrapped} }
