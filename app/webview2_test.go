package app

import "testing"

func TestWebView2Installed(t *testing.T) {
	for _, c := range []struct {
		pvs  []string
		want bool
	}{
		{nil, false},
		{[]string{""}, false},
		{[]string{"0.0.0.0"}, false},
		{[]string{" 0.0.0.0 ", ""}, false},
		{[]string{"131.0.2903.70"}, true},
		{[]string{"0.0.0.0", "", "131.0.2903.70"}, true},
	} {
		if got := webView2Installed(c.pvs); got != c.want {
			t.Errorf("webView2Installed(%q) = %v, want %v", c.pvs, got, c.want)
		}
	}
}

func TestAboutWebView2(t *testing.T) {
	for msg, want := range map[string]bool{
		`unable to initialise WebView2 for window "Launcher"`: true,
		"error getting webview2 version: not found":           true,
		"unable to create window":                             false,
	} {
		if got := aboutWebView2(msg); got != want {
			t.Errorf("aboutWebView2(%q) = %v, want %v", msg, got, want)
		}
	}
}
