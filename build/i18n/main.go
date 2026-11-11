// Command i18n keeps the translations in locales/ in step with the code (see locales/README.md).
//
// The windows' messages are collected by Lingui (`lingui extract`) into locales/<language>/app.po.
// This command does the same for the Go side: it reads the calls that carry text for the user
// (core/i18n's T, N, M and MN, and core/errs' constructors) and writes their messages to
// locales/en/core.po. It then brings every other language's core.po in step: a new message is
// added without a translation, and a message that the code no longer has is dropped.
//
//	go run ./build/i18n                 # write the Go side's catalogs (npm run i18n runs it)
//	go run ./build/i18n -check          # fail when anything is out of step (build/check.sh)
//	go run ./build/i18n -rclone         # write locales/en/rclone.json from the linked rclone
//	go run ./build/i18n -rclone -prune  # the same, and drop the keys that this rclone lacks
//
// -check fails when:
//   - a call's message isn't a string constant;
//   - a core.po differs from what the code gives now;
//   - a language in languages.json lacks one of its files;
//   - a language that ships complete (see `complete`) lacks a translation, in app.po or core.po;
//   - a translation's placeholders differ from its English message's, in a .po file or in a
//     setup question of rclone.json.
//
// It also warns, without failing, when a language's rclone.json lacks translations for the keys
// of en/rclone.json, or has keys that en no longer has. It compares the files with each other, and
// doesn't read rclone's registry.
//
// -rclone writes rclone's own text (see runRclone in rclone.go). The text comes from a command of
// its own, build/i18n/rclonetext, because that command links all of rclone and this one must stay
// quick for npm run i18n and -check.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// complete lists the languages that ship with every message translated. Any other language may
// be partly translated, and shows English for the rest.
var complete = []string{"es", "zh-CN"}

// plurals gives the Plural-Forms header of the languages that the app ships. A language that
// isn't here keeps the header its file has, which its translator writes.
var plurals = map[string]string{
	"en":    "nplurals=2; plural=(n != 1);",
	"es":    "nplurals=2; plural=(n != 1);",
	"zh-CN": "nplurals=1; plural=0;",
}

func main() {
	check := flag.Bool("check", false, "fail when the catalogs are out of step, and write nothing")
	rcloneText := flag.Bool("rclone", false, "write locales/en/rclone.json from the rclone that is linked into the app, and nothing else")
	prune := flag.Bool("prune", false, "with -rclone, drop the keys that the rclone on this system doesn't have")
	dir := flag.String("dir", ".", "the repository")
	flag.Parse()
	if *rcloneText {
		if err := runRclone(*dir, *prune); err != nil {
			fmt.Fprintln(os.Stderr, "i18n:", err)
			os.Exit(1)
		}
		return
	}
	problems, warnings, err := run(*dir, *check)
	if err != nil {
		fmt.Fprintln(os.Stderr, "i18n:", err)
		os.Exit(1)
	}
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "warning:", w)
	}
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, p)
	}
	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "i18n: %d problems\n", len(problems))
		os.Exit(1)
	}
}

// run writes the Go side's catalogs, or with check only compares them, and returns what is out
// of step. With check, it also returns the warnings about rclone's text (reviewRclone).
func run(dir string, check bool) (problems, warnings []string, err error) {
	langs, err := languages(dir)
	if err != nil {
		return nil, nil, err
	}
	x, err := extract(dir)
	if err != nil {
		return nil, nil, err
	}
	problems = append([]string(nil), x.problems...)
	for _, lang := range langs {
		path := filepath.Join(dir, "locales", lang, "core.po")
		old, err := readFile(path)
		if err != nil {
			return nil, nil, err
		}
		have, err := parsePO(old)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		next := merge(x, have, lang).String()
		switch {
		case next == old:
		case check:
			problems = append(problems, rel(dir, path)+" is out of date: run npm run i18n")
		default:
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return nil, nil, err
			}
			if err := os.WriteFile(path, []byte(next), 0o644); err != nil {
				return nil, nil, err
			}
		}
	}
	if !check {
		return problems, nil, nil
	}
	for _, lang := range langs {
		for _, name := range []string{"app.po", "core.po"} {
			path := filepath.Join(dir, "locales", lang, name)
			text, err := readFile(path)
			if err != nil {
				return nil, nil, err
			}
			if text == "" {
				problems = append(problems, rel(dir, path)+" is missing")
				continue
			}
			c, err := parsePO(text)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: %w", path, err)
			}
			if lang != "en" {
				problems = append(problems, review(c, rel(dir, path), name == "app.po", isComplete(lang))...)
			}
		}
	}
	rcloneProblems, warnings, err := reviewRclone(dir, langs)
	return append(problems, rcloneProblems...), warnings, err
}

func languages(dir string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "locales", "languages.json"))
	if err != nil {
		return nil, err
	}
	var names map[string]string
	if err := json.Unmarshal(b, &names); err != nil {
		return nil, fmt.Errorf("locales/languages.json: %w", err)
	}
	if _, ok := names["en"]; !ok {
		return nil, fmt.Errorf("locales/languages.json has no en")
	}
	var out []string
	for lang := range names {
		out = append(out, lang)
	}
	sort.Strings(out)
	return out, nil
}

func isComplete(lang string) bool {
	for _, l := range complete {
		if l == lang {
			return true
		}
	}
	return false
}

func rel(dir, path string) string {
	r, err := filepath.Rel(dir, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(r)
}

// merge returns lang's catalog for the code's messages: each message with the translation that
// have holds for it, and with the code's notes and files. English's catalog has no translations.
func merge(x *extraction, have *catalog, lang string) *catalog {
	out := &catalog{header: []string{
		"Content-Type: text/plain; charset=utf-8",
		"Language: " + lang,
	}}
	forms := plurals[lang]
	if forms == "" {
		forms = have.headerValue("Plural-Forms")
	}
	if forms == "" {
		forms = plurals["en"]
	}
	out.header = append(out.header, "Plural-Forms: "+forms)
	n := pluralCount(forms)
	for _, m := range x.messages {
		e := &entry{ctx: m.ctx, id: m.id, plural: m.plural, notes: m.notes}
		for f := range m.files {
			e.refs = append(e.refs, f)
		}
		sort.Strings(e.refs)
		sort.Strings(e.notes)
		want := 1
		if m.plural != "" {
			want = n
		}
		e.strs = make([]string, want)
		if old := have.find(e.key()); old != nil && lang != "en" {
			e.comments = old.comments
			// A translation is kept only while the message has the same shape: a message
			// that gained or lost its plural needs a new one.
			if (old.plural != "") == (m.plural != "") {
				copy(e.strs, old.strs)
			}
		}
		out.entries = append(out.entries, e)
	}
	return out
}

var nplurals = regexp.MustCompile(`nplurals\s*=\s*(\d+)`)

func pluralCount(forms string) int {
	if m := nplurals.FindStringSubmatch(forms); m != nil {
		var n int
		fmt.Sscan(m[1], &n)
		if n > 0 {
			return n
		}
	}
	return 2
}

// review returns what is wrong with a language's catalog: a missing translation, when the
// language ships complete, and a translation whose placeholders differ from its message's. icu
// says that the messages are Lingui's (ICU MessageFormat), and not fmt formats.
func review(c *catalog, path string, icu, mustBeComplete bool) []string {
	var problems []string
	missing := 0
	for _, e := range c.entries {
		if !e.translated() {
			missing++
			continue
		}
		for i, s := range e.strs {
			source := e.id
			if e.plural != "" && i > 0 {
				source = e.plural
			}
			var want, got string
			if icu {
				want, got = icuPlaceholders(source), icuPlaceholders(s)
			} else {
				want, got = verbs(source, e.plural != ""), verbs(s, e.plural != "")
			}
			if want != got {
				problems = append(problems, fmt.Sprintf("%s: the translation of %q has other placeholders (%s) than the message (%s)", path, e.id, orNone(got), orNone(want)))
			}
		}
	}
	if missing > 0 && mustBeComplete {
		problems = append(problems, fmt.Sprintf("%s: %d messages have no translation", path, missing))
	}
	return problems
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

var (
	// A value is "{name}" or "{name, plural …}" (or select, number…). A plural's branch is text
	// in braces, which may start with a word and a comma ("{Yes, with # rule}"): it is no value.
	icuArgument = regexp.MustCompile(`\{\s*([A-Za-z0-9_]+)\s*(?:\}|,\s*(?:plural|select|selectordinal|number|date|time)\b)`)
	// A branch's key comes right before its brace: "one {…}", "=0 {…}". A branch that is one
	// word ("one {Keep}") is text, not a value.
	icuBranchKey = regexp.MustCompile(`(?:^|[\s{}])(?:zero|one|two|few|many|other|=\d+)\s*$`)
	icuTag       = regexp.MustCompile(`</?([A-Za-z0-9_]+)\s*/?>`)
	verb         = regexp.MustCompile(`%(\[(\d+)\])?[-+# 0]*[0-9.]*([a-zA-Z%])`)
)

// icuPlaceholders returns the names of the values and the tags that an ICU message uses, sorted.
func icuPlaceholders(msg string) string {
	set := map[string]bool{}
	for _, m := range icuArgument.FindAllStringSubmatchIndex(msg, -1) {
		if icuBranchKey.MatchString(msg[:m[0]]) {
			continue
		}
		set["{"+msg[m[2]:m[3]]+"}"] = true
	}
	for _, m := range icuTag.FindAllStringSubmatch(msg, -1) {
		set["<"+m[1]+">"] = true
	}
	return joined(set)
}

// verbs returns the values that a fmt format uses, as "position:verb" pairs, sorted. A
// translation may put them in another order ("%[2]s"), so each is named by its position. A
// message about a count may leave the count out of one of its forms ("One file"), so its
// values are compared as a set that may shrink: see review.
func verbs(format string, plural bool) string {
	set := map[string]bool{}
	next := 1
	for _, m := range verb.FindAllStringSubmatch(format, -1) {
		if m[3] == "%" {
			continue
		}
		pos := next
		if m[2] != "" {
			fmt.Sscan(m[2], &pos)
		}
		next = pos + 1
		v := m[3]
		if v == "w" || v == "v" {
			v = "s" // an error or any value reads as text
		}
		set[fmt.Sprintf("%d:%s", pos, v)] = true
	}
	if plural {
		// The forms of one message may use different values, so only their kinds are compared
		// where both use them. That is too loose to check here, so a plural's forms pass.
		return ""
	}
	return joined(set)
}

func joined(set map[string]bool) string {
	var out []string
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}
