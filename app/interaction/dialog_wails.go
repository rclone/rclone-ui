//go:build darwin || linux

package interaction

import "github.com/wailsapp/wails/v3/pkg/application"

// On Linux, Wails builds a GTK 4 message dialog, where Escape and closing the window both choose
// the button marked as the cancel button.
func show(d Dialog) Answer {
	app := application.Get()
	var dlg *application.MessageDialog
	switch d.Kind {
	case Warning:
		dlg = app.Dialog.Warning()
	case Error:
		dlg = app.Dialog.Error()
	case Question:
		dlg = app.Dialog.Question()
	default:
		dlg = app.Dialog.Info()
	}
	dlg.SetTitle(d.Title).SetMessage(d.Message)
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
	// Buttons are added from left to right, so the default ends up on the right.
	if d.Extra != "" {
		add(d.Extra, AnswerExtra, false, false)
	}
	if d.Cancel != "" {
		add(d.Cancel, AnswerCancel, false, true)
	}
	add(d.OK, AnswerOK, true, d.Cancel == "")
	activate()
	dlg.Show()
	return <-answers
}
