package engine

import (
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

var testRemotes = []Remote{{Name: "gdrive", Type: "drive"}, {Name: "My Box", Type: "box"}}

// TestParseHome: ~ is replaced by the given home, so the core reads a full path.
func TestParseHome(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "me")
	sep := string(filepath.Separator)
	cases := []struct{ text, home, want string }{
		{"~", home, home},
		{"~/", home, home + sep},
		{"~/Photos", home, filepath.Join(home, "Photos")},
		{"~/Photos/", home, filepath.Join(home, "Photos") + sep},
		{"~/a/b", home, filepath.Join(home, "a", "b")},
		{"/x", "", "/x"},
		{`C:\x`, "", `C:\x`},
		{"~", "", ""},
		{"~/Photos", "", ""},
		{"~user/x", home, ""},
		{"./x", home, ""},
		{"../x", home, ""},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases, struct{ text, home, want string }{`~\Photos`, home, filepath.Join(home, "Photos")})
	} else {
		cases = append(cases, struct{ text, home, want string }{`~\Photos`, home, ""})
	}
	for _, c := range cases {
		q := Parse(c.text, testRemotes, c.home)
		got := ""
		if len(q.Paths) == 1 {
			got = q.Paths[0].Text
			if !q.Paths[0].Local {
				t.Errorf("%q: not local", c.text)
			}
		}
		if got != c.want {
			t.Errorf("%q with home %q: path %q, want %q", c.text, c.home, got, c.want)
		}
	}
	if _, p, ok := ReadClip("~/My Photos", nil, home); !ok || p.Text != filepath.Join(home, "My Photos") {
		t.Errorf("the clipboard's ~: %q, %v", p.Text, ok)
	}
	if _, _, ok := ReadClip("~/My Photos", nil, ""); ok {
		t.Error("the clipboard's ~ without a home")
	}
}

// TestParseOpenQuote: an unclosed quote is the word being typed, spaces included, and completion
// replaces it starting from the quote. A closed quote isn't being typed, and keeps its
// punctuation.
func TestParseOpenQuote(t *testing.T) {
	q := Parse(`copy "gdrive:My Folder/in`, testRemotes, "")
	if q.TypingFrom != 5 || q.Typing == nil || q.Typing.Text != "gdrive:My Folder/in" ||
		len(q.Paths) != 1 || !slices.Equal(q.Terms, []string{"copy"}) {
		t.Fatalf("open: from %d, typing %v, paths %v, terms %q", q.TypingFrom, q.Typing, q.Paths, q.Terms)
	}
	q = Parse(`copy "gdrive:My `, testRemotes, "")
	if q.TypingFrom != 5 || q.Typing == nil || q.Typing.Text != "gdrive:My " {
		t.Errorf("open, ending in a space: from %d, typing %v", q.TypingFrom, q.Typing)
	}
	for _, text := range []string{`copy "gdrive:My Folder/"`, `copy "gdrive:My Folder/" `} {
		q = Parse(text, testRemotes, "")
		if q.TypingFrom != len(text) || q.Typing != nil || len(q.Paths) != 1 || q.Paths[0].Text != "gdrive:My Folder/" {
			t.Errorf("%q: from %d, typing %v, paths %v", text, q.TypingFrom, q.Typing, q.Paths)
		}
	}
	q = Parse(`"gdrive:Hello!" gdrive:Hi!`, testRemotes, "")
	if len(q.Paths) != 2 || q.Paths[0].Text != "gdrive:Hello!" || q.Paths[1].Text != "gdrive:Hi" {
		t.Errorf("punctuation: %v", q.Paths)
	}
	for text, from := range map[string]int{"copy gdr": 5, "copy ": 5, "": 0, "my box:x": 0, "copy my box:x": 5} {
		if q := Parse(text, testRemotes, ""); q.TypingFrom != from {
			t.Errorf("%q: from %d, want %d", text, q.TypingFrom, from)
		}
	}
}

func TestParseURL(t *testing.T) {
	cases := map[string]string{
		"https://example.com":     "https://example.com",
		"example.com/archive.tar": "https://example.com/archive.tar",
		"files.host.io:8080/a":    "https://files.host.io:8080/a",
		"example.com?q=1":         "https://example.com?q=1",
		"example.com":             "",
		"report.pdf":              "",
		"a..b.com/x":              "",
	}
	for text, want := range cases {
		q := Parse(text, testRemotes, "")
		if q.URL != want {
			t.Errorf("%q: URL %q, want %q", text, q.URL, want)
		}
		if want == "" && !slices.Equal(q.Terms, []string{text}) {
			t.Errorf("%q: terms %q", text, q.Terms)
		}
	}
}
