package i18n

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/leonelquinteros/gotext"
)

// use puts a catalog in place of a language's file for one test, and makes it the language.
func use(t *testing.T, lang, po string) {
	t.Helper()
	p := gotext.NewPo()
	p.Parse([]byte("msgid \"\"\nmsgstr \"\"\n\"Plural-Forms: nplurals=2; plural=(n != 1);\\n\"\n\n" + po))
	catalogs.Store(lang, p)
	prev := current.Load()
	current.Store(&lang)
	t.Cleanup(func() {
		catalogs.Delete(lang)
		current.Store(prev)
	})
}

func TestText(t *testing.T) {
	use(t, "es", `
msgid "Stop %s?"
msgstr "¿Detener %s?"

msgid "%[1]s is not in %[2]s."
msgstr "En %[2]s no está %[1]s."

msgid "%d file"
msgid_plural "%d files"
msgstr[0] "%d archivo"
msgstr[1] "%d archivos"

msgid "100% done"
msgstr "100% hecho"

msgid "a serve"
msgstr "un servidor"
`)
	for _, c := range []struct {
		name          string
		text          Text
		english, here string
	}{
		{"values", M("Stop %s?", "gdrive"), "Stop gdrive?", "¿Detener gdrive?"},
		{"values in another order", M("%[1]s is not in %[2]s.", "a.txt", "gdrive:"), "a.txt is not in gdrive:.", "En gdrive: no está a.txt."},
		{"one", MN("%d file", "%d files", 1, 1), "1 file", "1 archivo"},
		{"many", MN("%d file", "%d files", 3, 3), "3 files", "3 archivos"},
		{"a text as a value", M("Stop %s?", M("a serve")), "Stop a serve?", "¿Detener un servidor?"},
		{"no values, so no format", M("100% done"), "100% done", "100% hecho"},
		{"not translated", M("Start %s", "now"), "Start now", "Start now"},
		{"empty", Text{}, "", ""},
	} {
		if got := c.text.String(); got != c.english {
			t.Errorf("%s: String() = %q, want %q", c.name, got, c.english)
		}
		if got := c.text.Local(); got != c.here {
			t.Errorf("%s: Local() = %q, want %q", c.name, got, c.here)
		}
	}
	if got := T("Stop %s?", "x"); got != "¿Detener x?" {
		t.Errorf("T = %q", got)
	}
	if got := N("%d file", "%d files", 2, 2); got != "2 archivos" {
		t.Errorf("N = %q", got)
	}
}

// texted is an error whose message is a Text, as the core's errors are.
type texted struct{ text Text }

func (e texted) Error() string { return e.text.String() }
func (e texted) Text() Text    { return e.text }

func TestLocalize(t *testing.T) {
	use(t, "es", `
msgid "That name is taken."
msgstr "Ese nombre ya está en uso."

msgid "Could not rename %s: %w"
msgstr "No se pudo renombrar %s: %w"
`)
	taken := texted{M("That name is taken.")}
	if got := Localize(taken); got != "Ese nombre ya está en uso." {
		t.Errorf("a text: %q", got)
	}
	// An error as a value is translated with the message around it.
	outer := texted{M("Could not rename %s: %w", "a", taken)}
	if got, want := Localize(outer), "No se pudo renombrar a: Ese nombre ya está en uso."; got != want {
		t.Errorf("a wrapped text: %q, want %q", got, want)
	}
	// Words that only fmt put around a text are English, so the whole stays English.
	wrapped := fmt.Errorf("renaming: %w", taken)
	if got := Localize(wrapped); got != "renaming: That name is taken." {
		t.Errorf("wrapped by fmt: %q", got)
	}
	if got := Localize(errors.New("disk full")); got != "disk full" {
		t.Errorf("another error: %q", got)
	}
	if got := Localize(nil); got != "" {
		t.Errorf("nil: %q", got)
	}
}

func TestPseudo(t *testing.T) {
	lang := Pseudo
	prev := current.Load()
	current.Store(&lang)
	t.Cleanup(func() { current.Store(prev) })
	for format, want := range map[string]string{
		"Stop":                     "[Stóp]",
		"Stop %s?":                 "[Stóp %s?]",
		"%[2]d of %[1]s, 100%% ok": "[%[2]d óf %[1]s, 100%% ók]",
		"ends with %":              "[éñds wíth %]",
	} {
		if got := pseudo(format); got != want {
			t.Errorf("pseudo(%q) = %q, want %q", format, got, want)
		}
	}
	if got := T("Stop %s?", "gdrive"); got != "[Stóp gdrive?]" {
		t.Errorf("T = %q", got)
	}
}

func TestMatch(t *testing.T) {
	for _, c := range []struct {
		preferred []string
		want      string
	}{
		{nil, "en"},
		{[]string{"en-US"}, "en"},
		{[]string{"es-MX", "en"}, "es"},
		{[]string{"es_ES.UTF-8"}, "es"},
		{[]string{"zh-Hans-US"}, "zh-CN"},
		{[]string{"zh_CN.UTF-8"}, "zh-CN"},
		{[]string{"zh-SG"}, "zh-CN"},
		{[]string{"zh"}, "zh-CN"},
		// Traditional Chinese is not Simplified.
		{[]string{"zh-TW"}, "en"},
		{[]string{"zh-Hant-HK", "zh-Hans"}, "zh-CN"},
		{[]string{"fr-FR", "es"}, "es"},
		{[]string{"fr", "de"}, "en"},
		{[]string{"C"}, "en"},
		{[]string{"not a language"}, "en"},
	} {
		if got := Match(c.preferred); got != c.want {
			t.Errorf("Match(%v) = %q, want %q", c.preferred, got, c.want)
		}
	}
}

func TestResolve(t *testing.T) {
	if got := Resolve("es"); got != "es" {
		t.Errorf("a language: %q", got)
	}
	if got := Resolve("xx"); got != English {
		t.Errorf("an unknown language: %q", got)
	}
	if got := Resolve(""); got != System() {
		t.Errorf("the system's: %q", got)
	}
	if !Valid("") || !Valid("zh-CN") || !Valid(Pseudo) || Valid("xx") {
		t.Error("Valid")
	}
}

func TestSaved(t *testing.T) {
	use(t, "es", `
msgid "%d file of %s failed: %w"
msgid_plural "%d files of %s failed: %w"
msgstr[0] "Falló %d archivo de %s: %w"
msgstr[1] "Fallaron %d archivos de %s: %w"

msgid "That name is taken."
msgstr "Ese nombre ya está en uso."
`)
	inner := texted{M("That name is taken.")}
	err := texted{MN("%d file of %s failed: %w", "%d files of %s failed: %w", 3, 3, "gdrive:", inner)}
	saved := Save(err)
	if !strings.HasPrefix(saved, savedMark) {
		t.Fatalf("saved as plain words: %q", saved)
	}
	back := Saved(saved)
	if got, want := back.String(), "3 files of gdrive: failed: That name is taken."; got != want {
		t.Errorf("English: %q, want %q", got, want)
	}
	if got, want := back.Local(), "Fallaron 3 archivos de gdrive:: Ese nombre ya está en uso."; got != want {
		t.Errorf("Spanish: %q, want %q", got, want)
	}
	// Another error is saved as its words, and reads back as them in every language.
	plainErr := errors.New("googleapi: Error 403: 100% of quota used")
	if got := Save(plainErr); got != plainErr.Error() {
		t.Errorf("another error saved as %q", got)
	}
	if got := Saved(plainErr.Error()).Local(); got != plainErr.Error() {
		t.Errorf("another error read as %q", got)
	}
	if Save(nil) != "" || !Saved("").IsZero() || Saved("").Local() != "" {
		t.Error("nothing saved")
	}
	// A broken record shows as it is rather than as nothing.
	if got := Saved(savedMark + "{not json").String(); got != savedMark+"{not json" {
		t.Errorf("a broken record: %q", got)
	}
}

func TestPlain(t *testing.T) {
	lang := Pseudo
	prev := current.Load()
	current.Store(&lang)
	t.Cleanup(func() { current.Store(prev) })
	words := Plain("googleapi: 100% of quota used")
	if got := words.Local(); got != "googleapi: 100% of quota used" {
		t.Errorf("plain words in the test language: %q", got)
	}
	if got := SaveText(words); got != "googleapi: 100% of quota used" {
		t.Errorf("plain words saved as %q", got)
	}
	if got := Saved("disk full").Local(); got != "disk full" {
		t.Errorf("plain words read back as %q", got)
	}
	// Plain words as a value of a message stay as they are, and are saved as words.
	msg := M("Could not copy: %s", Plain("disk full"))
	if got := msg.Local(); got != "[Çóúld ñót çópý: disk full]" {
		t.Errorf("plain words in a message: %q", got)
	}
	if got := Saved(SaveText(msg)).String(); got != "Could not copy: disk full" {
		t.Errorf("a message with plain words, saved and read back: %q", got)
	}
	if !Plain("").IsZero() {
		t.Error("empty words")
	}
}

func TestListAndCountless(t *testing.T) {
	use(t, "es", `
msgid "a mount"
msgid_plural "%d mounts"
msgstr[0] "un montaje"
msgstr[1] "%d montajes"

msgid "%s, %s"
msgstr "%s, %s"

msgid "%s and %s"
msgstr "%s y %s"

msgid "the remote tunnel"
msgstr "el túnel móvil"
`)
	one := MN("a mount", "%d mounts", 1, 1)
	if got := one.String(); got != "a mount" {
		t.Errorf("a form without the count, in English: %q", got)
	}
	if got := one.Local(); got != "un montaje" {
		t.Errorf("a form without the count, translated: %q", got)
	}
	list := List([]Text{MN("a mount", "%d mounts", 3, 3), M("the remote tunnel"), one})
	if got := list.String(); got != "3 mounts, the remote tunnel and a mount" {
		t.Errorf("a list in English: %q", got)
	}
	if got := list.Local(); got != "3 montajes, el túnel móvil y un montaje" {
		t.Errorf("a list translated: %q", got)
	}
	if !List(nil).IsZero() || List([]Text{one}).String() != "a mount" {
		t.Error("an empty list, or a list of one")
	}
}

func TestContextAndReorderedError(t *testing.T) {
	use(t, "es", `
msgctxt "menu bar"
msgid "Edit"
msgstr "Edición"

msgid "Edit"
msgstr "Editar"

msgid "Could not rename %s: %w"
msgstr "%[2]w: no se pudo renombrar %[1]s"
`)
	if got := TC("menu bar", "Edit"); got != "Edición" {
		t.Errorf("with a context: %q", got)
	}
	if got := T("Edit"); got != "Editar" {
		t.Errorf("without one: %q", got)
	}
	if got := MC("menu bar", "Edit").String(); got != "Edit" {
		t.Errorf("in English: %q", got)
	}
	if got := Saved(SaveText(MC("menu bar", "Edit"))).Local(); got != "Edición" {
		t.Errorf("saved and read back: %q", got)
	}
	if got := T("Could not rename %s: %w", "a", errors.New("disk full")); got != "disk full: no se pudo renombrar a" {
		t.Errorf("a reordered error: %q", got)
	}
}
