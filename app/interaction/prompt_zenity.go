//go:build !linux

package interaction

import (
	"errors"

	"github.com/ncruces/zenity"

	"github.com/rclone/rclone-ui/core/i18n"
)

// prompt asks through ncruces/zenity. It uses osascript on macOS and a Win32 dialog on Windows.
// Both would label their buttons in English (zenity's) or in the system's language (macOS's), so
// the buttons are given the app's own labels.
func prompt(title, message, def string, sensitive bool) (string, bool, error) {
	opts := []zenity.Option{
		zenity.Title(title), zenity.EntryText(def),
		zenity.OKLabel(i18n.T("OK")), zenity.CancelLabel(i18n.T("Cancel")),
	}
	if sensitive {
		opts = append(opts, zenity.HideText())
	}
	activate()
	defer raise(title)()
	value, err := zenity.Entry(message, opts...)
	if errors.Is(err, zenity.ErrCanceled) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}
