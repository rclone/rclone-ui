package deeplink

import "testing"

func TestQuoteExec(t *testing.T) {
	for in, want := range map[string]string{
		"/opt/rcui.AppImage":             `"/opt/rcui.AppImage"`,
		"/home/me/My Apps/rcui.AppImage": `"/home/me/My Apps/rcui.AppImage"`,
		"/home/me/100%/rcui.AppImage":    `"/home/me/100%%/rcui.AppImage"`,
		`/home/me/b\c/rcui.AppImage`:     `"/home/me/b\\\\c/rcui.AppImage"`,
		`/home/me/"q"/rcui.AppImage`:     `"/home/me/\\"q\\"/rcui.AppImage"`,
		"/home/me/$HOME/rcui.AppImage":   `"/home/me/\\$HOME/rcui.AppImage"`,
		"/home/me/a`b/rcui.AppImage":     "\"/home/me/a\\\\`b/rcui.AppImage\"",
	} {
		if got := QuoteExec(in); got != want {
			t.Errorf("QuoteExec(%q) = %s, want %s", in, got, want)
		}
	}
}
