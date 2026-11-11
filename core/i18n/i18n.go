// Package i18n translates the Go side's text into the app's language: native dialogs, the tray,
// toasts, the launcher's rows, notifications, and the errors that a page receives.
//
// The English text in the code is each message's key, and `npm run i18n` collects the messages
// into locales/<language>/core.po. A message uses fmt's verbs for its values. A translation that
// puts them in another order names them by position ("%[2]s").
//
// Text is translated where it leaves for the user, and not where it is made. A dialog's text is
// translated on the spot with T. An error, or anything else that is also logged, compared or
// saved, is made as a Text with M: it reads as English everywhere, and Local gives it in the
// app's language when it is shown.
//
// One language applies to the whole process (SetLanguage). It is English until the settings are
// read, unless the system's language is one the app has (System).
package i18n

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/leonelquinteros/gotext"
	"golang.org/x/text/language"

	"github.com/rclone/rclone-ui/locales"
)

// English is the language of the text in the code, and the fallback for a message that a
// language doesn't have.
const English = "en"

// Pseudo is the test language: English with accents, in brackets. A message that shows without
// them was never marked for translation. Only a dev build offers it.
const Pseudo = "pseudo"

// current is the language that T, N and Local translate into.
var current atomic.Pointer[string]

func Language() string {
	if l := current.Load(); l != nil {
		return *l
	}
	return English
}

// SetLanguage sets the language that text is translated into. setting is the language setting:
// one of Languages, Pseudo, or "" for the system's language. A language that the app doesn't have
// gives English. It returns the language that applies now.
func SetLanguage(setting string) string {
	lang := Resolve(setting)
	current.Store(&lang)
	return lang
}

// Resolve returns the language that a language setting gives: itself when the app has it, the
// system's language for "", and English otherwise.
func Resolve(setting string) string {
	switch {
	case setting == "":
		return System()
	case setting == Pseudo, slices.Contains(Languages(), setting):
		return setting
	}
	return English
}

// Valid reports whether setting is a language setting: "" (the system's language), a language
// that the app has, or Pseudo.
func Valid(setting string) bool {
	return setting == "" || setting == Pseudo || slices.Contains(Languages(), setting)
}

// languages reads locales/languages.json once: the languages that the app offers.
var languages = sync.OnceValue(func() []string {
	b, err := locales.FS.ReadFile("languages.json")
	if err != nil {
		return []string{English}
	}
	var names map[string]string
	if err := json.Unmarshal(b, &names); err != nil {
		return []string{English}
	}
	out := make([]string, 0, len(names))
	for tag := range names {
		out = append(out, tag)
	}
	slices.Sort(out)
	return out
})

// Languages returns the languages that the app has, as their tags ("en", "es", "zh-CN").
func Languages() []string { return languages() }

// catalogs holds each language's messages, read from its core.po the first time it is used.
var catalogs sync.Map // language -> *gotext.Po

// catalog returns lang's messages, or nil for English, Pseudo and a language without a file.
func catalog(lang string) *gotext.Po {
	if lang == English || lang == Pseudo {
		return nil
	}
	if po, ok := catalogs.Load(lang); ok {
		return po.(*gotext.Po)
	}
	var po *gotext.Po
	if b, err := locales.FS.ReadFile(lang + "/core.po"); err == nil {
		po = gotext.NewPo()
		po.Parse(b)
	}
	actual, _ := catalogs.LoadOrStore(lang, po)
	return actual.(*gotext.Po)
}

// T returns a message in the app's language, with its values filled in. format is the English
// message, with fmt's verbs.
func T(format string, args ...any) string { return M(format, args...).Local() }

// N returns a message about a count in the app's language: singular for one, plural otherwise,
// and whatever forms the language has. n is not among the message's values unless it is passed
// in args too.
func N(singular, plural string, n int, args ...any) string {
	return MN(singular, plural, n, args...).Local()
}

// Text is a message that is translated when it is shown. It holds the English message and its
// values. The zero Text is empty.
type Text struct {
	format string
	plural string // the plural message, for a message about a count
	n      int
	args   []any
	words  bool   // the text is words that aren't translated (Plain): format is the words
	ctx    string // the message's context, for a word that has another meaning elsewhere
}

// M makes a Text from an English message with fmt's verbs, and its values. A value that is a
// Text, or an error made from one, is translated along with the message.
func M(format string, args ...any) Text { return Text{format: format, args: args} }

// MN makes a Text about a count, from the English message for one and the message for more.
func MN(singular, plural string, n int, args ...any) Text {
	return Text{format: singular, plural: plural, n: n, args: args}
}

// TC returns a message with a context in the app's language: the same English word with another
// meaning elsewhere, such as the menu bar's "Copy" and the Copy window. ctx names the meaning.
func TC(ctx, format string, args ...any) string { return MC(ctx, format, args...).Local() }

// MC makes a Text of a message with a context (see TC).
func MC(ctx, format string, args ...any) Text { return Text{format: format, args: args, ctx: ctx} }

// Plain makes a Text of words that aren't translated, such as rclone's own error or the OS's.
// They read the same in every language, the test language included, and are saved as they are.
func Plain(words string) Text {
	if words == "" {
		return Text{}
	}
	return Text{format: words, words: true}
}

func (t Text) IsZero() bool { return t.format == "" }

// String returns the text in English, for logs, tests and anything that is saved.
func (t Text) String() string { return t.in(English) }

// Local returns the text in the app's language.
func (t Text) Local() string { return t.in(Language()) }

// in returns the text in lang. A message that lang doesn't have stays English.
func (t Text) in(lang string) string {
	if t.format == "" {
		return ""
	}
	if t.words {
		return t.format
	}
	format := t.format
	if t.plural != "" && t.n != 1 {
		format = t.plural
	}
	switch po := catalog(lang); {
	case lang == Pseudo:
		format = pseudo(format)
	case po == nil:
	case t.plural != "" && t.ctx != "":
		// The catalog is asked for the translated format alone, and the values are filled in
		// below. Its methods are held in variables because vet takes them for fmt.Sprintf.
		getNC := po.GetNC
		format = getNC(t.format, t.plural, t.n, t.ctx)
	case t.plural != "":
		getN := po.GetN
		format = getN(t.format, t.plural, t.n)
	case t.ctx != "":
		getC := po.GetC
		format = getC(t.format, t.ctx)
	default:
		get := po.Get
		format = get(t.format)
	}
	if len(t.args) == 0 {
		// A message without values is not a format, so a "%" in it stays as it is.
		return format
	}
	args := make([]any, len(t.args))
	for i, a := range t.args {
		switch v := a.(type) {
		case Text:
			args[i] = v.in(lang)
		case error:
			args[i] = errorIn(v, lang)
		default:
			args[i] = a
		}
	}
	// A wrapped error (%w, or %[2]w in a translation that reorders) is a value like any other
	// once the message is text.
	out := fmt.Sprintf(wrapVerb.ReplaceAllString(format, "%${1}v"), args...)
	if t.plural != "" {
		// A form of a message about a count may leave the count out ("a transfer", or a
		// language's "una transferencia"). fmt then lists the values it didn't use at the end.
		if i := strings.Index(out, "%!(EXTRA "); i >= 0 {
			out = out[:i]
		}
	}
	return out
}

// List joins texts as a sentence names several things: "A", "A and B", "A, B and C". The joins
// are messages, so each language joins its own way.
func List(items []Text) Text {
	switch len(items) {
	case 0:
		return Text{}
	case 1:
		return items[0]
	}
	head := items[0]
	for _, item := range items[1 : len(items)-1] {
		// i18n: Joins the items of a list, before its last one: "a transfer, 2 mounts".
		head = M("%s, %s", head, item)
	}
	// i18n: Joins the last item of a list: "2 transfers and a serve".
	return M("%s and %s", head, items[len(items)-1])
}

// wrapVerb finds fmt's %w, which only fmt.Errorf reads, with its position when it has one.
var wrapVerb = regexp.MustCompile(`%(\[\d+\])?w`)

// Texter is an error, or any other value, whose message is a Text.
type Texter interface{ Text() Text }

// Localize returns err's message in the app's language. An error whose message isn't a Text
// (rclone's, the OS's) keeps its own words.
func Localize(err error) string {
	if err == nil {
		return ""
	}
	return errorIn(err, Language())
}

// errorIn returns err's message in lang, when err itself is a Texter. An error that only wraps
// one keeps its own words, because the words around the wrapped message are English.
func errorIn(err error, lang string) string {
	var t Texter
	if errors.As(err, &t) && sameMessage(err, t) {
		return t.Text().in(lang)
	}
	return err.Error()
}

// sameMessage reports whether err says exactly what the Texter found in its chain says, so that
// translating the Texter translates all of err.
func sameMessage(err error, t Texter) bool { return err.Error() == t.Text().String() }

// supported are the app's languages as tags, for matching the system's.
var supported = sync.OnceValue(func() map[string]language.Tag {
	out := map[string]language.Tag{}
	for _, l := range Languages() {
		if tag, err := language.Parse(l); err == nil {
			out[l] = tag
		}
	}
	return out
})

// Match returns the first of the preferred languages that the app has, or English. A language
// matches when its base language and its script are the app's, whatever its region: "es-MX" is
// Spanish, and "zh-SG" is Simplified Chinese. Traditional Chinese ("zh-TW", "zh-Hant") is not
// Simplified, and gets English until the app has it.
func Match(preferred []string) string {
	for _, p := range preferred {
		tag, err := language.Parse(normalize(p))
		if err != nil {
			continue
		}
		base, _ := tag.Base()
		script, _ := tag.Script()
		for name, have := range supported() {
			hb, _ := have.Base()
			hs, _ := have.Script()
			if base == hb && script == hs {
				return name
			}
		}
	}
	return English
}

// normalize turns a POSIX locale ("zh_CN.UTF-8", "es_ES@euro") into a language tag ("zh-CN").
func normalize(locale string) string {
	if i := strings.IndexAny(locale, ".@"); i >= 0 {
		locale = locale[:i]
	}
	return strings.ReplaceAll(strings.TrimSpace(locale), "_", "-")
}

// SystemEnv names an environment variable that takes the place of the system's language, such as
// APP_LANGUAGE=es. The dev tools set it to en, because their scripts find buttons by their English
// labels.
const SystemEnv = "APP_LANGUAGE"

// system reads the system's language once: it doesn't change while the app runs. Under `go test`
// it is English, so that a test reads the same text on every machine.
var system = sync.OnceValue(func() string {
	if lang := os.Getenv(SystemEnv); lang != "" {
		return Match([]string{lang})
	}
	if testing.Testing() {
		return English
	}
	return Match(systemLanguages())
})

// System returns the app's language for this system: the first of the user's preferred languages
// that the app has, or English.
func System() string { return system() }
