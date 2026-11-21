package engine

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

var (
	// A word that looks like a domain counts as an https URL when a path, a port or a query
	// follows the name: "example.com/x", "files.host.io:8080/a". A name alone ("report.pdf") is
	// a plain word.
	domainRE = regexp.MustCompile(`^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[/:?]\S*$`)
	// a Windows drive path: "C:\x", "c:/x"
	driveRE = regexp.MustCompile(`^[a-zA-Z]:[\\/]`)
)

// Parse parses text. home is the folder that ~ stands for, or "" for none.
func Parse(text string, remotes []Remote, home string) Query {
	q := Query{Text: text, TypingFrom: len(text)}
	byName := map[string]Remote{}
	for _, r := range remotes {
		byName[strings.ToLower(r.Name)] = r
	}
	toks := tokenize(text, remotes)
	for i, t := range toks {
		word := t.text
		if !t.quoted {
			word = strings.TrimRight(word, ".,;!?") // strip sentence punctuation, unless quoted
		}
		// the caret is at the end of the last word, unless a space or a closing quote follows it
		typing := i == len(toks)-1 && (t.open || !t.quoted && t.start+len(t.text) == len(text))
		if typing {
			q.TypingFrom = t.start
		}
		if p, ok := readPath(word, byName, home); ok {
			q.Paths = append(q.Paths, p)
			if typing {
				p := p
				q.Typing = &p
			}
			continue
		}
		if q.URL == "" && !t.quoted {
			if u, ok := readURL(word); ok {
				q.URL = u
				continue
			}
		}
		if w := strings.TrimSpace(word); w != "" {
			q.Terms = append(q.Terms, w)
			if typing {
				q.TypingWord = w
			}
		}
	}
	return q
}

// token is a word of the text. quoted means it was in quotes (which aren't included in text).
// open means its quote wasn't closed, so it runs to the end of the text. start is where the word
// starts in the text, including its opening quote.
type token struct {
	text   string
	quoted bool
	open   bool
	start  int
}

// tokenize splits text into words. A quoted string is one word, and so is a remote name that
// contains spaces (the longest one that matches and is followed by the end, a space or a colon).
func tokenize(text string, remotes []Remote) []token {
	var spaced []string
	for _, r := range remotes {
		if strings.ContainsAny(r.Name, " \t") {
			spaced = append(spaced, r.Name)
		}
	}
	sort.Slice(spaced, func(i, j int) bool { return len(spaced[i]) > len(spaced[j]) })
	var out []token
	s := text
	for {
		s = strings.TrimLeftFunc(s, unicode.IsSpace)
		if s == "" {
			return out
		}
		start := len(text) - len(s)
		if q := s[0]; q == '"' || q == '\'' || q == '`' {
			end := strings.IndexByte(s[1:], q)
			if end < 0 {
				// still being typed: the rest of the text, spaces included, is the word
				return append(out, token{text: s[1:], quoted: true, open: true, start: start})
			}
			out = append(out, token{text: s[1 : end+1], quoted: true, start: start})
			s = s[end+2:]
			continue
		}
		if name, ok := spacedRemote(s, spaced); ok {
			rest := s[len(name):]
			end := strings.IndexFunc(rest, unicode.IsSpace)
			if end < 0 {
				end = len(rest)
			}
			out = append(out, token{text: s[:len(name)+end], start: start})
			s = rest[end:]
			continue
		}
		end := strings.IndexFunc(s, unicode.IsSpace)
		if end < 0 {
			end = len(s)
		}
		out = append(out, token{text: s[:end], start: start})
		s = s[end:]
	}
}

func spacedRemote(s string, names []string) (string, bool) {
	for _, n := range names {
		if len(s) < len(n) || !strings.EqualFold(s[:len(n)], n) {
			continue
		}
		rest := s[len(n):]
		if rest == "" || rest[0] == ':' || unicode.IsSpace(rune(rest[0])) {
			return s[:len(n)], true
		}
	}
	return "", false
}

// readPath reads a word as a path. A path is a known remote's name alone, the name with a colon
// and a path after it, or a local path (/x, C:\x, and ~ or ~/x in home). A relative path (./x,
// ../x) doesn't count, because the core would resolve it against the app's working folder.
// Neither does ~user/x, nor ~ when there is no home folder.
func readPath(word string, remotes map[string]Remote, home string) (Path, bool) {
	if word == "" {
		return Path{}, false
	}
	if r, ok := remotes[strings.ToLower(word)]; ok {
		return Path{Text: r.Name + ":", Remote: r.Name, Features: r.Features}, true
	}
	if word[0] == '~' {
		if p, ok := inHome(word[1:], home); ok {
			return Path{Text: p, Local: true}, true
		}
		return Path{}, false
	}
	if driveRE.MatchString(word) || strings.HasPrefix(word, "/") {
		return Path{Text: word, Local: true}, true
	}
	name, rest, ok := strings.Cut(word, ":")
	if !ok || name == "" || strings.HasPrefix(rest, "//") {
		return Path{}, false
	}
	r, known := remotes[strings.ToLower(name)]
	if !known {
		return Path{}, false
	}
	return Path{Text: r.Name + ":" + rest, Remote: r.Name, Features: r.Features}, true
}

// inHome resolves rest (what follows a ~) inside home. It keeps a trailing separator, which
// completion needs. It returns false for ~user/x, and when there is no home folder.
func inHome(rest, home string) (string, bool) {
	if home == "" {
		return "", false
	}
	if rest == "" {
		return home, true
	}
	if rest[0] != '/' && rest[0] != filepath.Separator {
		return "", false
	}
	p := filepath.Join(home, rest)
	if last := rest[len(rest)-1]; (last == '/' || last == filepath.Separator) && !strings.HasSuffix(p, string(filepath.Separator)) {
		p += string(filepath.Separator)
	}
	return p, true
}

// ReadClip reads the clipboard's text as a single web link or a single path (a local path may
// contain spaces). It returns false for anything else.
func ReadClip(text string, remotes []Remote, home string) (url string, p Path, ok bool) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 2048 || strings.ContainsAny(text, "\r\n") {
		return "", Path{}, false
	}
	// Only accept a link with a scheme. Otherwise copied text like "report.pdf" would look like a
	// domain.
	if l := strings.ToLower(text); (strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "http://")) && !strings.ContainsAny(text, " \t") {
		return text, Path{}, true
	}
	byName := map[string]Remote{}
	for _, r := range remotes {
		byName[strings.ToLower(r.Name)] = r
	}
	if p, ok := readPath(text, byName, home); ok {
		return "", p, true
	}
	return "", Path{}, false
}

func readURL(word string) (string, bool) {
	if strings.Contains(word, "://") {
		return word, true
	}
	if domainRE.MatchString(word) && !strings.Contains(word, "..") {
		return "https://" + word, true
	}
	return "", false
}

// shorten keeps a deep path readable by showing the root, its first folder, "…" and the last two
// names.
func shorten(p string) string {
	root := ""
	rest := p
	if i := strings.Index(p, ":"); i >= 0 && !driveRE.MatchString(p) {
		root, rest = p[:i+1], p[i+1:]
	}
	lead := ""
	if strings.HasPrefix(rest, "/") {
		lead, rest = "/", strings.TrimLeft(rest, "/")
	}
	parts := strings.Split(strings.TrimRight(rest, "/"), "/")
	if len(parts) <= 4 {
		return p
	}
	return root + lead + parts[0] + "/…/" + parts[len(parts)-2] + "/" + parts[len(parts)-1]
}
