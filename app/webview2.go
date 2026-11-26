package app

import (
	"errors"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails exits as soon as this returns after a fatal error.
func (u *ui) wailsError(err error) {
	u.log.Error("wails", "error", err)
	var fatal *application.FatalError
	if errors.As(err, &fatal) {
		if cause := fatal.Unwrap(); cause != nil && aboutWebView2(cause.Error()) {
			u.webView2Failed(cause)
		}
	}
}

func aboutWebView2(msg string) bool {
	return strings.Contains(strings.ToLower(msg), "webview2")
}

// https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution#detect-if-a-webview2-runtime-is-already-installed
// An empty pv or 0.0.0.0 doesn't count, because an uninstall can leave either behind.
func webView2Installed(pvs []string) bool {
	for _, pv := range pvs {
		if pv = strings.TrimSpace(pv); pv != "" && pv != "0.0.0.0" {
			return true
		}
	}
	return false
}
