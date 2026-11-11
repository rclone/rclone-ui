package app

import (
	"errors"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// wailsError handles an error that Wails reports. Every error is logged. A fatal error about
// WebView2 also gets a dialog on Windows (see webView2Failed), because Wails exits as soon as this
// returns, and the user would otherwise see nothing. A window that can't start WebView2 is most
// likely in a portable copy, which has no installer to install the WebView2 runtime.
func (u *ui) wailsError(err error) {
	u.log.Error("wails", "error", err)
	var fatal *application.FatalError
	if errors.As(err, &fatal) {
		if cause := fatal.Unwrap(); cause != nil && aboutWebView2(cause.Error()) {
			u.webView2Failed(cause)
		}
	}
}

// aboutWebView2 reports whether an error's message is about WebView2, as in Wails' "unable to
// initialise WebView2 for window".
func aboutWebView2(msg string) bool {
	return strings.Contains(strings.ToLower(msg), "webview2")
}

// webView2Installed reports whether the WebView2 runtime is installed, from the pv values that
// Microsoft's guide says to read (see webView2Versions on Windows):
// https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution#detect-if-a-webview2-runtime-is-already-installed
// The runtime is installed when one of them holds a version. An empty value or 0.0.0.0 doesn't
// count, because an uninstall can leave either behind.
func webView2Installed(pvs []string) bool {
	for _, pv := range pvs {
		if pv = strings.TrimSpace(pv); pv != "" && pv != "0.0.0.0" {
			return true
		}
	}
	return false
}
