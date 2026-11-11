package catalog

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/lib/oauthutil"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/locales"
)

// rclone's own text (backend descriptions, the help of options and their examples, backend
// command help, metadata help, and the questions of a remote's setup) is translated in
// locales/<language>/rclone.json. Each file is a tree keyed by backend, option block and option
// name, in the shape of rclone-ui/rclone-i18n's language packs:
//
//	backend.<backend>.description
//	backend.<backend>.option.<option>.help
//	backend.<backend>.option.<option>.example.<value>.help
//	backend.<backend>.option.<option>.provider.<provider>.help
//	backend.<backend>.option.<option>.provider.<provider>.example.<value>.help
//	backend.<backend>.extra.commandhelp.<command>.short (and .long)
//	backend.<backend>.extra.metadatainfo.help
//	backend.<backend>.extra.metadatainfo.system.<key>.help
//	options.<block>.option.<option>.help
//	options.<block>.option.<option>.example.<value>.help
//	setup.question.<name>.help
//	setup.confirm.example.<value>.help
//	setup.error.help
//	setup.backend.<backend>.question.<name>.help
//	setup.backend.<backend>.question.<name>.example.<value>.help
//	setup.backend.<backend>.error.help
//
// An option that rclone defines once per provider keeps its help under that provider, and so
// does an example for one provider. An example whose value is "" is keyed __empty__.
//
// The setup keys hold the questions that rclone asks while a remote is set up, and the errors
// that it shows before asking again. setup.question and setup.error are rclone's common config's
// (its sign-in, and the advanced options), which any backend may ask. setup.backend holds those
// that one backend asks in its Config function, and the help of their fixed choices. When a
// backend asks one question with several texts, or shows several errors, the second text is
// help_2, the third help_3. A question's help and an error are fmt formats, because rclone puts
// values in many of them ("Found drive %q of type %q"): a "%" of rclone's own is "%%". The help of
// a choice, and the yes and no of setup.confirm, are plain text.
//
// locales/en/rclone.json is the English text, which `go run ./build/i18n -rclone` writes from the
// rclone that is linked in (EnglishTexts), and from rclone's source for the backends' setup
// questions, which no registry holds. A translation is used only while the English text that
// en/rclone.json holds for its key is still rclone's text, so a text that a newer rclone changed
// shows in English until it is translated again. A setup format is rclone's text when it matches
// it, with any values (setupText).
//
// The catalog itself is built and kept in English, which validation and command building read.
// The API localises a copy for the pages (SummaryIn, BackendIn), one per language.

// emptyValue is the key of an example whose value is "".
const emptyValue = "__empty__"

// sep joins the parts of a key in the flat form of a text file. No text of rclone's holds it.
const sep = "\x00"

func key(parts ...string) string { return strings.Join(parts, sep) }

func valueKey(v string) string {
	if v == "" {
		return emptyValue
	}
	return v
}

// helpKey returns the key of an option's help, under prefix (backend.<name> or
// options.<block>).
func helpKey(prefix string, o *fs.Option) string {
	if o.Provider != "" {
		return key(prefix, "option", o.Name, "provider", o.Provider, "help")
	}
	return key(prefix, "option", o.Name, "help")
}

// exampleKey returns the key of the help of one of an option's examples. An example belongs to
// its own provider, or to its option's.
func exampleKey(prefix string, o *fs.Option, ex *fs.OptionExample) string {
	provider := ex.Provider
	if provider == "" {
		provider = o.Provider
	}
	if provider != "" {
		return key(prefix, "option", o.Name, "provider", provider, "example", valueKey(ex.Value), "help")
	}
	return key(prefix, "option", o.Name, "example", valueKey(ex.Value), "help")
}

func backendPrefix(name string) string { return key("backend", name) }

func blockPrefix(name string) string { return key("options", name) }

// EnglishTexts returns rclone's translatable text from its registry, by key (see the top of this
// file), with the parts of each key joined by "\x00". It is what locales/en/rclone.json holds,
// and build/i18n writes the file from it. An empty text is left out.
func EnglishTexts() map[string]string {
	out := map[string]string{}
	set := func(k, text string) {
		if text != "" {
			out[k] = text
		}
	}
	addOptions := func(prefix string, options fs.Options) {
		for i := range options {
			o := &options[i]
			set(helpKey(prefix, o), o.Help)
			for j := range o.Examples {
				set(exampleKey(prefix, o, &o.Examples[j]), o.Examples[j].Help)
			}
		}
	}
	for _, ri := range fs.Registry {
		prefix := backendPrefix(ri.Name)
		set(key(prefix, "description"), ri.Description)
		addOptions(prefix, ri.Options)
		for _, c := range ri.CommandHelp {
			set(key(prefix, "extra", "commandhelp", c.Name, "short"), c.Short)
			set(key(prefix, "extra", "commandhelp", c.Name, "long"), c.Long)
		}
		if mi := ri.MetadataInfo; mi != nil {
			set(key(prefix, "extra", "metadatainfo", "help"), mi.Help)
			for k, h := range mi.System {
				set(key(prefix, "extra", "metadatainfo", "system", k, "help"), h.Help)
			}
		}
	}
	for name, info := range fs.OptionsRegistry {
		addOptions(blockPrefix(name), info.Options)
	}
	for _, q := range setupQuestions() {
		// A question's help is a format in the files, and this one has no values.
		set(key("setup", "question", q.Name, "help"), strings.ReplaceAll(q.Help, "%", "%%"))
		for _, ex := range q.Examples {
			set(key("setup", "confirm", "example", valueKey(ex.Value), "help"), ex.Help)
		}
	}
	return out
}

// setupQuestions returns the questions that rclone's config asks during almost every remote's
// setup, whatever the backend: the ones of its OAuth sign-in (lib/oauthutil), and whether to edit
// the advanced options (fs/backend_config.go). They are asked here through rclone's own config
// steps, so that their text is rclone's. The other questions are in no registry: build/i18n reads
// them from rclone's source, and checks that it reads these ones as they are here.
func setupQuestions() []*fs.Option {
	ctx := context.Background()
	oauth := &fs.RegInfo{
		Name: "rcui-setup",
		Config: func(context.Context, string, configmap.Mapper, fs.ConfigIn) (*fs.ConfigOut, error) {
			return oauthutil.ConfigOut("", &oauthutil.Options{OAuth2Config: &oauthutil.Config{
				AuthURL: "https://example.invalid/auth", TokenURL: "https://example.invalid/token",
			}})
		},
	}
	advanced := &fs.RegInfo{Name: "rcui-setup", Options: fs.Options{{Name: "a", Default: "", Advanced: true}}}
	var out []*fs.Option
	ask := func(ri *fs.RegInfo, m configmap.Simple, state string) {
		step, err := fs.BackendConfig(ctx, "rcui-setup", m, ri, configmap.Simple{}, fs.ConfigIn{State: state})
		if err == nil && step != nil && step.Option != nil {
			out = append(out, step.Option)
		}
	}
	ask(oauth, configmap.Simple{}, "")              // config_is_local
	ask(oauth, configmap.Simple{"token": "{}"}, "") // config_refresh_token
	ask(advanced, configmap.Simple{}, fs.ConfigAll) // config_fs_advanced
	return out
}

// texts is one language's translation of rclone's text, with the English text that it was made
// from.
type texts struct {
	en, local map[string]string

	setupOnce sync.Once
	setup     map[string][]*setupFormat // see setupFormats
}

// text returns the translation of the text at k, when english is still the text that it was
// translated from, and english otherwise.
func (t *texts) text(k, english string) string {
	if t == nil || english == "" || t.en[k] != english {
		return english
	}
	if s := t.local[k]; s != "" {
		return s
	}
	return english
}

// option returns a copy of o with its help and its examples' help translated. prefix is the key
// of its backend or block.
func (t *texts) option(prefix string, o fs.Option) fs.Option {
	if t == nil {
		return o
	}
	o.Help = t.text(helpKey(prefix, &o), o.Help)
	if len(o.Examples) > 0 {
		examples := slices.Clone(o.Examples)
		for i := range examples {
			examples[i].Help = t.text(exampleKey(prefix, &o, &examples[i]), examples[i].Help)
		}
		o.Examples = examples
	}
	return o
}

// metadataInfo returns a copy of backend's metadata help, translated.
func (t *texts) metadataInfo(backend string, mi *fs.MetadataInfo) *fs.MetadataInfo {
	if t == nil || mi == nil {
		return mi
	}
	prefix := key(backendPrefix(backend), "extra", "metadatainfo")
	out := &fs.MetadataInfo{Help: t.text(key(prefix, "help"), mi.Help)}
	if mi.System != nil {
		out.System = make(map[string]fs.MetadataHelp, len(mi.System))
		for k, h := range mi.System {
			h.Help = t.text(key(prefix, "system", k, "help"), h.Help)
			out.System[k] = h
		}
	}
	return out
}

// readTexts reads a text file of locales/ into its flat form: a key for each text, with its parts
// joined by sep.
func readTexts(lang string) (map[string]string, error) {
	b, err := locales.FS.ReadFile(lang + "/rclone.json")
	if err != nil {
		return nil, err
	}
	var tree map[string]any
	if err := json.Unmarshal(b, &tree); err != nil {
		return nil, err
	}
	out := map[string]string{}
	var walk func(prefix string, node map[string]any)
	walk = func(prefix string, node map[string]any) {
		for k, v := range node {
			if prefix != "" {
				k = prefix + sep + k
			}
			switch v := v.(type) {
			case string:
				out[k] = v
			case map[string]any:
				walk(k, v)
			}
		}
	}
	walk("", tree)
	return out, nil
}

var englishFile = sync.OnceValue(func() map[string]string {
	m, _ := readTexts(i18n.English)
	return m
})

// loaded holds each language's texts, read the first time the language is used.
var loaded sync.Map // language -> *texts

// textsFor returns lang's translation of rclone's text, or nil when rclone's English applies:
// for English, for the pseudo-language (which leaves rclone's text alone), and for a language
// without a file.
func textsFor(lang string) *texts {
	if lang == i18n.English || lang == i18n.Pseudo || lang == "" {
		return nil
	}
	if t, ok := loaded.Load(lang); ok {
		return t.(*texts)
	}
	var t *texts
	if local, err := readTexts(lang); err == nil && len(local) > 0 {
		t = &texts{en: englishFile(), local: local}
	}
	actual, _ := loaded.LoadOrStore(lang, t)
	return actual.(*texts)
}

// localSummaries holds the summary in each language, made the first time it is asked for.
var localSummaries sync.Map // language -> *Catalog

// SummaryIn returns the summary (see Summary) with rclone's text in lang. English, the
// pseudo-language and a language without translations get the English summary itself. Callers
// must not change it.
func (s *Service) SummaryIn(lang string) *Catalog {
	sum := s.Summary()
	t := textsFor(lang)
	if t == nil {
		return sum
	}
	if c, ok := localSummaries.Load(lang); ok {
		return c.(*Catalog)
	}
	out := *sum
	out.Backends = make([]Backend, len(sum.Backends))
	for i, b := range sum.Backends {
		b.Description = t.text(key(backendPrefix(b.Name), "description"), b.Description)
		b.MetadataInfo = t.metadataInfo(b.Name, b.MetadataInfo)
		out.Backends[i] = b
	}
	blocks := convertBlocks(t)
	out.Blocks = make([]Block, len(sum.Blocks))
	for i, b := range sum.Blocks {
		out.Blocks[i] = Block{Name: b.Name, Options: blocks[b.Name]}
	}
	actual, _ := localSummaries.LoadOrStore(lang, &out)
	return actual.(*Catalog)
}

// BackendIn returns Backend's result with rclone's text in lang.
func (s *Service) BackendIn(typ, provider, lang string) (*BackendOptions, error) {
	return s.backend(typ, provider, textsFor(lang))
}

// setupFormat is the English text of a setup question or error, as en/rclone.json holds it: a fmt
// format, made into a pattern that matches rclone's text and finds its values.
type setupFormat struct {
	key     string
	pattern *regexp.Regexp
	// verbs holds the verb of each value, in order: q for a quoted string, s for any text, and d
	// for a number.
	verbs []byte
	// size is the length of the format's own words. A longer format is tried first, because
	// it is the more particular: "Failed to query available drives: /me/drives: %v…" before
	// "Failed to query available drives: %v".
	size int
}

// formatVerb finds a verb of a format, or a "%%".
var formatVerb = regexp.MustCompile(`%[^%a-zA-Z]*[a-zA-Z%]`)

// newSetupFormat makes the pattern of the format at key. Each verb is a value: %q matches a
// Go-quoted string, %s and %v any text, and %d digits. It returns nil for a format with any other
// verb, or with a verb's index, flags or width, which build/i18n never writes.
func newSetupFormat(key, format string) *setupFormat {
	f := &setupFormat{key: key}
	var re strings.Builder
	re.WriteString(`(?s)^`)
	words := func(s string) {
		re.WriteString(regexp.QuoteMeta(s))
		f.size += len(s)
	}
	last := 0
	for _, m := range formatVerb.FindAllStringIndex(format, -1) {
		words(format[last:m[0]])
		last = m[1]
		switch format[m[0]:m[1]] {
		case "%%":
			words("%")
		case "%q":
			re.WriteString(`("(?:[^"\\]|\\.)*")`)
			f.verbs = append(f.verbs, 'q')
		case "%s", "%v":
			re.WriteString(`(.*?)`)
			f.verbs = append(f.verbs, 's')
		case "%d":
			re.WriteString(`(-?[0-9]+)`)
			f.verbs = append(f.verbs, 'd')
		default:
			return nil
		}
	}
	words(format[last:])
	re.WriteString(`$`)
	f.pattern = regexp.MustCompile(re.String())
	return f
}

// match returns the values that text has in place of the format's verbs. It reports false when
// text doesn't match the format.
func (f *setupFormat) match(text string) ([]any, bool) {
	m := f.pattern.FindStringSubmatch(text)
	if m == nil {
		return nil, false
	}
	values := make([]any, len(f.verbs))
	for i, verb := range f.verbs {
		s := m[i+1]
		switch verb {
		case 'q':
			v, err := strconv.Unquote(s)
			if err != nil {
				return nil, false
			}
			values[i] = v
		case 'd':
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil, false
			}
			values[i] = n
		default:
			values[i] = s
		}
	}
	return values, true
}

// setupGroup returns k without its last part, when k is the key of a setup question's or error's
// text. The result is the key of the question (or of the errors) that the text belongs to.
func setupGroup(k string) (string, bool) {
	parts := strings.Split(k, sep)
	n := len(parts)
	if parts[0] != "setup" || !helpVariant.MatchString(parts[n-1]) {
		return "", false
	}
	switch {
	case n == 3 && parts[1] == "error", // setup.error.help
		n == 4 && parts[1] == "question",                          // setup.question.<name>.help
		n == 5 && parts[1] == "backend" && parts[3] == "error",    // setup.backend.<backend>.error.help
		n == 6 && parts[1] == "backend" && parts[3] == "question": // setup.backend.<backend>.question.<name>.help
		return key(parts[:n-1]...), true
	}
	return "", false
}

// helpVariant is the last part of the key of a setup question's or error's text: help, help_2…
var helpVariant = regexp.MustCompile(`^help(_[0-9]+)?$`)

// setupFormats returns the English formats of the setup questions and errors, keyed by the key
// that setupGroup returns, with the longest format first (see setupFormat.size). They are made
// from t.en on the first call.
func (t *texts) setupFormats() map[string][]*setupFormat {
	t.setupOnce.Do(func() {
		t.setup = map[string][]*setupFormat{}
		for k, format := range t.en {
			if group, ok := setupGroup(k); ok {
				if f := newSetupFormat(k, format); f != nil {
					t.setup[group] = append(t.setup[group], f)
				}
			}
		}
		for _, formats := range t.setup {
			slices.SortFunc(formats, func(a, b *setupFormat) int {
				return cmp.Or(cmp.Compare(b.size, a.size), strings.Compare(a.key, b.key))
			})
		}
	})
	return t.setup
}

// setupText returns english, a question or an error that rclone gave during a remote's setup, in
// t's language. groups are the keys of the questions (or errors) that it may be, the backend's
// first and then the common config's. The first format that matches english gives its
// translation, with english's values filled in. A text that no format matches, because rclone
// changed it or the files lack it, stays English, as does one whose format isn't translated.
func (t *texts) setupText(english string, groups ...string) string {
	if t == nil || english == "" {
		return english
	}
	formats := t.setupFormats()
	for _, g := range groups {
		for _, f := range formats[g] {
			values, ok := f.match(english)
			if !ok {
				continue
			}
			local := t.local[f.key]
			if local == "" {
				return english
			}
			// A translation may put the values in another order ("%[2]s"). One with a verb that
			// its values don't fit would show fmt's complaint, so English shows instead.
			if out := fmt.Sprintf(local, values...); !strings.Contains(out, "%!") || strings.Contains(english, "%!") {
				return out
			}
			return english
		}
	}
	return english
}

// backendName returns the name that the backend of a remote's type registers, which the texts
// are keyed by. The type itself can also be the backend's prefix or file name.
func backendName(typ string) string {
	if ri, err := fs.Find(typ); err == nil {
		return ri.Name
	}
	return typ
}

// FromQuestion describes a question of a remote's setup (the Option in fs.ConfigOut) for a page,
// as FromOption does, with rclone's text in the app's language: the question's help, its fixed
// choices' help and its yes or no. typ is the remote's backend, whose own questions are tried
// before the common ones of rclone's config. A choice that is the user's data (a drive's name)
// keeps its text, and so does any question that the files don't have.
func FromQuestion(typ string, o *fs.Option) *Option {
	if o == nil {
		return nil
	}
	t := textsFor(i18n.Language())
	if t == nil {
		return FromOption(o)
	}
	backend := key("setup", "backend", backendName(typ), "question", o.Name)
	q := *o
	q.Help = t.setupText(q.Help, backend, key("setup", "question", q.Name))
	if len(q.Examples) > 0 {
		q.Examples = slices.Clone(q.Examples)
		for i := range q.Examples {
			ex := &q.Examples[i]
			v := valueKey(ex.Value)
			if help := t.text(key(backend, "example", v, "help"), ex.Help); help != ex.Help {
				ex.Help = help
			} else {
				ex.Help = t.text(key("setup", "confirm", "example", v, "help"), ex.Help)
			}
		}
	}
	return convert(&q)
}

// LocalNotice returns an error that rclone showed during a remote's setup (fs.ConfigOut's Error,
// which the session shows with the question that follows), in the app's language. typ is the
// remote's backend. A text that the files don't have keeps rclone's English.
func LocalNotice(typ, notice string) string {
	t := textsFor(i18n.Language())
	if t == nil || notice == "" {
		return notice
	}
	return t.setupText(notice, key("setup", "backend", backendName(typ), "error"), key("setup", "error"))
}

// LocalMetadataInfo returns a backend's metadata help (fs.RegInfo.MetadataInfo, as a remote's
// fsinfo also gives it) in the app's language. It returns mi itself in English, and otherwise a
// translated copy.
func LocalMetadataInfo(backend string, mi *fs.MetadataInfo) *fs.MetadataInfo {
	return textsFor(i18n.Language()).metadataInfo(backend, mi)
}
