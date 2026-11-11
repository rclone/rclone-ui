package windows

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestDarkTitleBar(t *testing.T) {
	for _, c := range []struct {
		theme      string
		systemDark bool
		want       bool
	}{
		{"dark", false, true},
		{"light", true, false},
		{"", true, true},
		{"", false, false},
	} {
		if got := darkTitleBar(c.theme, c.systemDark); got != c.want {
			t.Errorf("%q, system dark %v: %v", c.theme, c.systemDark, got)
		}
	}
}

func TestCreationTheme(t *testing.T) {
	for _, c := range []struct {
		theme      string
		systemDark bool
		want       application.Theme
	}{
		{"light", true, application.Light},
		{"dark", false, application.Dark},
		{"", true, application.Dark},
		{"", false, application.Light},
	} {
		if got := creationTheme(c.theme, c.systemDark); got != c.want {
			t.Errorf("%q, system dark %v: %v, want %v", c.theme, c.systemDark, got, c.want)
		}
	}
}
