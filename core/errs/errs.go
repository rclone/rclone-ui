package errs

import (
	"context"
	"errors"
	"fmt"

	"github.com/rclone/rclone-ui/core/i18n"
)

type Code string

const (
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

	text i18n.Text
	err  error
}

type FieldViolation struct {
	Field       string `json:"field"`
	Description string `json:"description"`

	text i18n.Text
}

type TransferRef struct {
	ID  string `json:"id"`
	Seq int64  `json:"seq"`
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Unwrap() error { return e.err }

func (e *Error) Text() i18n.Text {
	if e.text.IsZero() {
		return i18n.Plain(e.Message)
	}
	return e.text
}

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

type sentence struct {
	text i18n.Text
	err  error
}

func (s *sentence) Error() string { return s.err.Error() }

func (s *sentence) Unwrap() error { return s.err }

func (s *sentence) Text() i18n.Text { return s.text }

func New(msg string) error { return &sentence{i18n.M(msg), errors.New(msg)} }

// Errorf returns fmt.Errorf's error as a refusal, shown to the user. A %w operand can still be
// found with errors.Is and errors.As.
func Errorf(format string, a ...any) error {
	return &sentence{i18n.M(format, a...), fmt.Errorf(format, a...)}
}

// Sentence returns a refusal whose message is a text made elsewhere, such as a message about a
// count (i18n.MN). Unlike Errorf, an error among the text's values isn't wrapped.
func Sentence(text i18n.Text) error { return &sentence{text, errors.New(text.String())} }

func FieldText(field string, text i18n.Text) error {
	return &FieldError{Field: field, Message: text.String(), text: text}
}

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

func FieldOf(err error) string {
	var f *FieldError
	if errors.As(err, &f) {
		return f.Field
	}
	return ""
}

func said(code Code, text i18n.Text) *Error {
	return &Error{Code: code, Message: text.String(), text: text}
}

func Invalid(text i18n.Text, fields ...FieldViolation) *Error {
	e := said(CodeInvalid, text)
	e.Fields = fields
	return e
}

func Violation(field, format string, a ...any) FieldViolation {
	text := i18n.M(format, a...)
	return FieldViolation{Field: field, Description: text.String(), text: text}
}

func NotFound(what, format string, a ...any) *Error {
	e := said(CodeNotFound, i18n.M(format, a...))
	e.What = what
	return e
}

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

func Said(code Code, text i18n.Text) *Error { return said(code, text) }

func Reconnect(remote string, err error) *Error {
	return &Error{Code: CodeReconnect, Message: err.Error(), Remote: remote, err: err}
}

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
