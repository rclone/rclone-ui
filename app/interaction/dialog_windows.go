package interaction

import (
	"errors"

	"github.com/ncruces/zenity"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// show uses Wails' question dialog, because that is the one Wails shows as a Windows task dialog
// when it has buttons of its own (#5794). A task dialog sizes its buttons to their labels, where a
// plain message box keeps the standard size and cuts a longer label short ("Skip This Version").
// It also puts itself above every window when it opens, including the Startup window and the
// launcher, which stay on top and would hide a plain message box. Before Wails' application is
// made, zenity's message box shows the dialog. Every caller runs once the application has started,
// because until then Wails would show nothing.
func show(d Dialog) Answer {
	app := application.Get()
	if app == nil {
		return showZenity(d)
	}
	// Wails shows the app's own icon for any icon it's given, so the bytes don't matter.
	dlg := app.Dialog.Question().SetTitle(d.Title).SetMessage(d.Message).SetIcon([]byte{0})
	answers := make(chan Answer, 1)
	add := func(label string, a Answer, isDefault, isCancel bool) {
		b := dlg.AddButton(label)
		b.IsDefault, b.IsCancel = isDefault, isCancel
		b.OnClick(func() {
			select {
			case answers <- a:
			default:
			}
		})
	}
	// Windows puts the default button first. Escape and the close button choose the button
	// marked as the cancel button, so one is always marked, and an answer always arrives.
	add(d.OK, AnswerOK, true, d.Cancel == "")
	if d.Extra != "" {
		add(d.Extra, AnswerExtra, false, false)
	}
	if d.Cancel != "" {
		add(d.Cancel, AnswerCancel, false, true)
	}
	activate()
	dlg.Show()
	select {
	case a := <-answers:
		return a
	default:
		// No button reported, which only happens if the dialog couldn't be shown.
		return AnswerCancel
	}
}

// ShowPlain shows d in a plain Win32 message box, which needs nothing from Wails, and waits for
// the answer. It is for when Wails itself failed, as when WebView2 doesn't start, and it may be
// called from the main thread then. A message box's buttons keep the standard width, so their
// labels must be short ("Download", not "Download WebView2").
func ShowPlain(d Dialog) Answer { return present(d, showZenity) }

// showZenity shows the dialog with zenity's Win32 message box, which can relabel its buttons.
func showZenity(d Dialog) Answer {
	opts := []zenity.Option{zenity.Title(d.Title), zenity.OKLabel(d.OK)}
	switch d.Kind {
	case Warning:
		opts = append(opts, zenity.WarningIcon)
	case Error:
		opts = append(opts, zenity.ErrorIcon)
	case Question:
		opts = append(opts, zenity.QuestionIcon)
	default:
		opts = append(opts, zenity.InfoIcon)
	}
	if d.Cancel == "" && d.Extra == "" {
		// With one button, closing the box gives the same answer.
		_ = zenity.Info(d.Message, opts...)
		return AnswerOK
	}
	if d.Extra != "" {
		opts = append(opts, zenity.ExtraButton(d.Extra))
	}
	var err error
	if d.Cancel == "" {
		// OK and Extra only. A question box would add its own Cancel button (Yes, No and
		// Cancel), while a message box has just two (Yes and No).
		err = zenity.Info(d.Message, opts...)
	} else {
		err = zenity.Question(d.Message, append(opts, zenity.CancelLabel(d.Cancel))...)
	}
	switch {
	case err == nil:
		return AnswerOK
	case errors.Is(err, zenity.ErrExtraButton):
		return AnswerExtra
	default:
		return AnswerCancel
	}
}
