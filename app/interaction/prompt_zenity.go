//go:build !linux

package interaction

import (
	"errors"

	"github.com/ncruces/zenity"

	"github.com/rclone/rclone-ui/core/i18n"
)

// zenity labels the buttons in English, and osascript in the system's language.
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
