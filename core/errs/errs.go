// Package errs defines the core's errors in the form that the pages receive them: a code, a
// message, and whatever the page needs to act on the error (the rejected fields, the remote to
// reconnect, or the transfer that a failed start recorded).
//
// A service gives its errors their code where it makes them, for example with NotFound or
// Precondition, and the APIs return them unchanged. The shell converts every error that a page
// receives once, with rclone.ErrorOf.
//
// The message is shown to the user. A refusal's text is a full sentence (capitalized, sometimes
// with a period), unlike the lower-case fragments of Go's usual error strings, because it is the
// whole message rather than part of a longer one. rclone's own failures keep rclone's wording.
//
// A message is written in English, as a format with its values. Error() and Message give it in
// English, for logs, tests and comparisons. The shell translates it when a page receives the
// error (Localized), so every constructor here takes a format and its values like fmt.Errorf,
// and `npm run i18n` collects the formats for translation (core/i18n).
package errs

import (
	"context"
	"errors"
	"fmt"

	"github.com/rclone/rclone-ui/core/i18n"
)

// Code is the kind of error, which tells a page what it can do about it.
type Code string

const (
	// CodeInvalid is a rejected request, because of a field's value or the request as a whole.
	CodeInvalid Code = "invalid"
	// CodeNotFound is a path, a remote or an id that doesn't exist (What says which).
	CodeNotFound Code = "not_found"
	// CodeUnsupported is a feature that the remote or the OS doesn't have (What names it).
	CodeUnsupported Code = "unsupported"
	// CodePrecondition rejects a request that the current state doesn't allow. For example, an
	// encrypted config needs its password first.
	CodePrecondition Code = "precondition"
	// CodeReconnect means that Remote's sign-in has expired.
	CodeReconnect Code = "reconnect"
	// CodeFailed means that rclone rejected the request or failed it. Pages show rclone's message
	// unchanged.
	CodeFailed Code = "failed"
	// CodeInternal is a failure that the caller couldn't have prevented by changing the request.
	CodeInternal Code = "internal"
	// CodeCanceled is a request that its caller canceled.
	CodeCanceled Code = "canceled"
	// CodeUnavailable is a request that the core can't handle now (because it is starting or
	// stopping).
	CodeUnavailable Code = "unavailable"
)

type Error struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
	// Fields are the rejected fields of an Invalid request, keyed by the names that the form
	// uses (a request field, "options.<group>", or an rclone option name).
	Fields []FieldViolation `json:"fields,omitempty"`
	// What names the thing that doesn't exist (NotFound), that isn't supported (Unsupported), or
	// that is missing for a Precondition.
	What string `json:"what,omitempty"`
	// Remote is the remote whose sign-in has expired (Reconnect).
	Remote string `json:"remote,omitempty"`
	// Transfer is the transfer that a start recorded before it failed (Failed, or Precondition for
	// a first bisync).
	Transfer *TransferRef `json:"transfer,omitempty"`

	text i18n.Text // Message as a translatable text, for the errors made here
	err  error
}

type FieldViolation struct {
	Field       string `json:"field"`
	Description string `json:"description"`

	text i18n.Text // Description as a translatable text
}

type TransferRef struct {
	ID  string `json:"id"`
	Seq int64  `json:"seq"`
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Unwrap() error { return e.err }

// Text returns e's message as a translatable text. For an error made from another one (rclone's,
// the OS's), that is the other error's own words.
func (e *Error) Text() i18n.Text {
	if e.text.IsZero() {
		return i18n.Plain(e.Message)
	}
	return e.text
}

// Localized returns a copy of e with its message, and the descriptions of its rejected fields, in
// the app's language. The shell sends this to the page. The error that e was made from is
// translated too, when it is one of the core's.
func (e *Error) Localized() *Error {
	out := *e
	switch {
	case !e.text.IsZero():
		out.Message = e.text.Local()
	case e.err != nil:
		out.Message = i18n.Localize(e.err)
	}
	if len(e.Fields) > 0 {
		out.Fields = make([]FieldViolation, len(e.Fields))
		for i, f := range e.Fields {
			if !f.text.IsZero() {
				f.Description = f.text.Local()
			}
			out.Fields[i] = f
		}
	}
	return &out
}

// FieldError rejects the value of one field of a request. Field is the field's name as the form
// knows it, and Message is shown to the user (in English here, see Text).
type FieldError struct {
	Field   string
	Message string

	text i18n.Text
}

func (e *FieldError) Error() string { return e.Message }

func (e *FieldError) Text() i18n.Text {
	if e.text.IsZero() {
		return i18n.Plain(e.Message)
	}
	return e.text
}

// sentence is an error whose text is shown to the user.
type sentence struct {
	text i18n.Text
	err  error
}

func (s *sentence) Error() string { return s.err.Error() }

func (s *sentence) Unwrap() error { return s.err }

func (s *sentence) Text() i18n.Text { return s.text }

// New returns a refusal with the message msg. Like errors.New, each call returns a distinct error.
func New(msg string) error { return &sentence{i18n.M(msg), errors.New(msg)} }

// Errorf returns fmt.Errorf's error as a refusal, shown to the user. A %w operand can still be
// found with errors.Is and errors.As.
func Errorf(format string, a ...any) error {
	return &sentence{i18n.M(format, a...), fmt.Errorf(format, a...)}
}

// Sentence returns a refusal whose message is a text made elsewhere, such as a message about a
// count (i18n.MN). Unlike Errorf, an error among the text's values isn't wrapped.
func Sentence(text i18n.Text) error { return &sentence{text, errors.New(text.String())} }

// FieldText returns an error that rejects field's value, with a message that is a text made
// elsewhere.
func FieldText(field string, text i18n.Text) error {
	return &FieldError{Field: field, Message: text.String(), text: text}
}

// Field returns an error that rejects field's value, with a message made like fmt.Sprintf's.
func Field(field, format string, a ...any) error {
	text := i18n.M(format, a...)
	return &FieldError{Field: field, Message: text.String(), text: text}
}

// Is reports whether err is, or wraps, a refusal made by New, Errorf or Field.
func Is(err error) bool {
	var s *sentence
	var f *FieldError
	return errors.As(err, &s) || errors.As(err, &f)
}

// FieldOf returns the field that err rejects (from a FieldError in its chain), or "" when it
// rejects none.
func FieldOf(err error) string {
	var f *FieldError
	if errors.As(err, &f) {
		return f.Field
	}
	return ""
}

// said returns an Error with a code and a message. Each constructor below takes the message as a
// format and its values, like fmt.Sprintf.
func said(code Code, text i18n.Text) *Error {
	return &Error{Code: code, Message: text.String(), text: text}
}

// Invalid returns a rejected request with the message text and the rejected fields. The text is
// made with i18n.M, because the fields take the place of a format's values.
func Invalid(text i18n.Text, fields ...FieldViolation) *Error {
	e := said(CodeInvalid, text)
	e.Fields = fields
	return e
}

// Violation returns one rejected field, for Invalid.
func Violation(field, format string, a ...any) FieldViolation {
	text := i18n.M(format, a...)
	return FieldViolation{Field: field, Description: text.String(), text: text}
}

// NotFound returns an error for something that doesn't exist. what names its kind, such as
// "watcher".
func NotFound(what, format string, a ...any) *Error {
	e := said(CodeNotFound, i18n.M(format, a...))
	e.What = what
	return e
}

// Unsupported returns an error for a feature that isn't available here. what names the feature.
func Unsupported(what, format string, a ...any) *Error {
	e := said(CodeUnsupported, i18n.M(format, a...))
	e.What = what
	return e
}

func Precondition(format string, a ...any) *Error {
	return said(CodePrecondition, i18n.M(format, a...))
}

func Canceled(format string, a ...any) *Error {
	return said(CodeCanceled, i18n.M(format, a...))
}

// Said returns an error with a code and a message that is already a Text, for a message about a
// count (i18n.MN) or one that is made elsewhere.
func Said(code Code, text i18n.Text) *Error { return said(code, text) }

// Reconnect reports that the remote's sign-in has expired. err is rclone's error.
func Reconnect(remote string, err error) *Error {
	return &Error{Code: CodeReconnect, Message: err.Error(), Remote: remote, err: err}
}

// Unavailable returns an error for a request that the core can't handle now, because it is
// starting, stopping, or failed to start.
func Unavailable(err error) *Error {
	return &Error{Code: CodeUnavailable, Message: err.Error(), err: err}
}

// Internal returns an error for a failure that the caller couldn't have prevented by changing the
// request. An *Error in err's chain is returned as it is.
func Internal(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: CodeInternal, Message: err.Error(), err: err}
}

func Failed(err error) *Error {
	return &Error{Code: CodeFailed, Message: err.Error(), err: err}
}

// Launched returns an error for a start that failed after its transfer was recorded. It holds
// rclone's error and the transfer, so the page can follow it.
func Launched(err error, id string, seq int64) *Error {
	return &Error{Code: CodeFailed, Message: err.Error(), Transfer: &TransferRef{ID: id, Seq: seq}, err: err}
}

// Of returns err in the form that the pages receive, when err is one of the core's own errors.
// An *Error in err's chain is returned as it is. A refusal made by New, Errorf or Field becomes
// Invalid, with the field it rejects. A canceled request becomes Canceled. Of returns nil for any
// other error, which is rclone's or the OS's. rclone.ErrorOf classifies those.
func Of(err error) *Error {
	var e *Error
	var f *FieldError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &e):
		return e
	case errors.As(err, &f):
		return &Error{Code: CodeInvalid, Message: err.Error(), Fields: []FieldViolation{{Field: f.Field, Description: f.Message, text: f.Text()}}, err: err}
	case Is(err):
		return &Error{Code: CodeInvalid, Message: err.Error(), err: err}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return &Error{Code: CodeCanceled, Message: err.Error(), err: err}
	}
	return nil
}
