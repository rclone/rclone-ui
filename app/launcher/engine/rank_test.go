package engine

import (
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/i18n"
)

// TestKeylessResultsHaveNoHistory: a result with no key is ranked as if it was never picked, even
// if the history has an entry under "".
func TestKeylessResultsHaveNoHistory(t *testing.T) {
	now := time.Now()
	results := []Result{
		{ID: "a", Title: "Alpha", Score: 3},
		{ID: "b", Title: "Beta", Score: 2},
		{ID: "k", Key: "op:k", Title: "Kappa", Score: 1},
	}
	withEmpty := Usage{"": {Count: 9, Last: now, Queries: []string{"a"}}}
	for _, q := range []Query{{}, {Text: "a", Terms: []string{"a"}}} {
		got := Rank(q, results, withEmpty, now)
		want := Rank(q, results, nil, now)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("query %q: an entry under \"\" changed the ranking:\n got %+v\nwant %+v", q.Text, got, want)
		}
		for _, r := range got {
			if r.Score >= recentBoost {
				t.Errorf("query %q: %q lifted as a recent (score %d)", q.Text, r.Title, r.Score)
			}
		}
	}
}

func inLanguage(t *testing.T, lang string) {
	t.Helper()
	i18n.SetLanguage(lang)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
}

func ids(rs []Result) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.ID
	}
	return out
}

// TestSayMatchesBothLanguages: typing finds a row by its title and its search words in the app's
// language and in English. Only a match in the drawn title is drawn bold. The test language
// (Pseudo) stands in for a translation: "Copy" is "[Çópý]" there.
func TestSayMatchesBothLanguages(t *testing.T) {
	inLanguage(t, i18n.Pseudo)
	now := time.Now()
	results := []Result{
		Result{ID: "copy", Score: 2}.Say(i18n.M("Copy"), i18n.M("duplicate, cp")),
		Result{ID: "move", Score: 1}.Say(i18n.M("Move"), i18n.M("rename, mv")),
		// A title that is a name is kept, and only the search words are translated.
		Result{ID: "remote", Title: "gdrive"}.Say(i18n.Text{}, i18n.M("browse")),
	}
	if got := results[0].Title; got != "[Çópý]" {
		t.Fatalf("title %q, want the translated title", got)
	}
	if got := results[2].Title; got != "gdrive" {
		t.Fatalf("a name's title became %q", got)
	}
	for _, c := range []struct {
		typed string
		want  []string
		bold  bool // the match is in the drawn title
	}{
		{"copy", []string{"copy"}, false},      // the English title
		{"çópý", []string{"copy"}, true},       // the translated title
		{"çó", []string{"copy"}, true},         // its start
		{"duplicate", []string{"copy"}, false}, // an English search word
		{"dúplíçá", []string{"copy"}, false},   // a translated search word
		{"cp", []string{"copy"}, false},        // a word that both languages share
		{"rename", []string{"move"}, false},
		{"brówsé", []string{"remote"}, false},
		{"browse", []string{"remote"}, false},
		{"gdr", []string{"remote"}, true},
		{"paste", nil, false},
	} {
		q := Query{Text: c.typed, Terms: []string{c.typed}}
		got := Rank(q, results, nil, now)
		if !slices.Equal(ids(got), c.want) {
			t.Errorf("%q found %q, want %q", c.typed, ids(got), c.want)
			continue
		}
		if len(got) > 0 && (len(got[0].Match()) > 0) != c.bold {
			t.Errorf("%q: bold runes %v, want bold %v", c.typed, got[0].Match(), c.bold)
		}
	}
}

// TestSayInEnglish: in English, the English terms are the drawn ones, so none is kept twice.
func TestSayInEnglish(t *testing.T) {
	inLanguage(t, i18n.English)
	r := Result{ID: "copy"}.Say(i18n.M("Copy"), i18n.M("copy, cp"))
	if r.Title != "Copy" || !slices.Equal(r.Keywords, []string{"copy", "cp"}) || len(r.English) != 0 {
		t.Errorf("title %q, keywords %q, English %q", r.Title, r.Keywords, r.English)
	}
}

// TestWordsSplitsOnEveryComma: a translation may separate its search words with its own commas.
func TestWordsSplitsOnEveryComma(t *testing.T) {
	for in, want := range map[string][]string{
		"copy, cp":     {"copy", "cp"},
		"复制，拷贝、cp":     {"复制", "拷贝", "cp"},
		" a , , b ":    {"a", "b"},
		"keep in sync": {"keep in sync"},
		"":             nil,
	} {
		if got := splitWords(in); !slices.Equal(got, want) {
			t.Errorf("splitWords(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestGroupTitles: every group has a label of its own.
func TestGroupTitles(t *testing.T) {
	inLanguage(t, i18n.Pseudo)
	seen := map[string]bool{}
	for _, g := range groupOrder {
		title := GroupTitle(g)
		if title == g || seen[title] {
			t.Errorf("group %q is shown as %q", g, title)
		}
		seen[title] = true
	}
}
