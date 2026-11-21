package windows

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/leonelquinteros/gotext"

	"github.com/rclone/rclone-ui/core/i18n"
)

// A route of src/routes.ts and the title of its look: "settings: {" and, a few lines down,
// "look: { title: t`Settings`".
var routeTitle = regexp.MustCompile("(?s)\\n    ([a-z]+): \\{[^}]*?title: t`([^`]+)`")

// The titles that Go gives the windows are the pages' own (src/routes.ts), so a window's title
// doesn't change when its page has loaded. In another language, a title is translated.
func TestTitlesMatchThePages(t *testing.T) {
	src, err := os.ReadFile("../../src/routes.ts")
	if err != nil {
		t.Fatal(err)
	}
	found := routeTitle.FindAllStringSubmatch(string(src), -1)
	if len(found) < 20 {
		t.Fatalf("only %d titles were read from src/routes.ts: has its layout changed?", len(found))
	}
	for _, m := range found {
		route, title := m[1], m[2]
		name := strings.ToUpper(route[:1]) + route[1:]
		if got, _ := ForRoute("/" + route); got != name {
			t.Errorf("the window of /%s is named %q, want %q", route, got, name)
		}
		if got := Title(name); got != title {
			t.Errorf("Title(%q) = %q, but its page's title is %q", name, got, title)
		}
	}
	if got := Title("Startup"); got != "Startup" {
		t.Errorf("a window without a title of its own: %q", got)
	}

	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	if got := Title("Settings"); got != "[Séttíñgs]" {
		t.Errorf("in another language: %q", got)
	}
}

// A title is translated twice: for Go, which gives it to the window (core.po), and for the page,
// which sets it again once it has loaded (app.po). The two translations must be the same in every
// language, or the title would change under the user's eyes.
func TestTitlesAreTranslatedTheSameOnBothSides(t *testing.T) {
	src, err := os.ReadFile("../../src/routes.ts")
	if err != nil {
		t.Fatal(err)
	}
	catalog := func(lang, file string) *gotext.Po {
		b, err := os.ReadFile(filepath.Join("../../locales", lang, file))
		if err != nil {
			t.Fatal(err)
		}
		po := gotext.NewPo()
		po.Parse(b)
		return po
	}
	for _, lang := range i18n.Languages() {
		if lang == i18n.English {
			continue
		}
		core, app := catalog(lang, "core.po"), catalog(lang, "app.po")
		for _, m := range routeTitle.FindAllStringSubmatch(string(src), -1) {
			title := m[2]
			// Each catalog is asked for the translation alone. The methods are held in variables
			// because vet takes them for fmt.Sprintf.
			fromCore, fromApp := core.Get, app.Get
			if c, a := fromCore(title), fromApp(title); c != a {
				t.Errorf("%s: %q is %q for Go and %q for the page", lang, title, c, a)
			}
		}
	}
}
