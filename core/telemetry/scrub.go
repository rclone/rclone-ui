package telemetry

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const messageMax = 300

var (
	reURL    = regexp.MustCompile(`\b[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]+`)
	reQuoted = regexp.MustCompile("\"[^\"\n]*\"|`[^`\n]*`")
	reEmail  = regexp.MustCompile(`[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}`)
	reIP     = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)

	reWinPath  = regexp.MustCompile(`\b([A-Za-z]):\\|(\\)\\`)
	reUnixPath = regexp.MustCompile(`(?:^|[\s(=:,\[])(~?/)[^\s]`)
	reRemote   = regexp.MustCompile(`\b([A-Za-z])[\w.-]*:[^\s"',)\]<>]`)
)

func pathEnd(m string) int {
	end := len(m)
	for _, stop := range []string{": ", "\n", `"`, ")", "]", ","} {
		if i := strings.Index(m, stop); i >= 0 && i < end {
			end = i
		}
	}
	return end
}

func cutPaths(m string, start *regexp.Regexp, tag string) string {
	var out strings.Builder
	for {
		loc := start.FindStringSubmatchIndex(m)
		if loc == nil {
			out.WriteString(m)
			return out.String()
		}
		at := loc[2]
		for i := 2; i < len(loc); i += 2 {
			if loc[i] >= 0 {
				at = loc[i]
				break
			}
		}
		out.WriteString(m[:at])
		out.WriteString(tag)
		m = m[at+pathEnd(m[at:]):]
	}
}

// Scrub returns an error's message without what could name the user's things: addresses, quoted
// text, e-mail addresses, paths on this computer and on remotes, the remotes' own names, and IP
// addresses. Each is replaced by a word in angle brackets, so the message still reads. It errs on
// the side of taking out too much. The result is cut to messageMax characters.
func (s *Service) Scrub(message string) string {
	var names []string
	if s.o.Names != nil {
		names = s.o.Names()
	}
	return scrub(message, names)
}

func scrub(message string, names []string) string {
	m := reURL.ReplaceAllString(message, "<url>")
	m = reQuoted.ReplaceAllString(m, "<quoted>")
	m = reEmail.ReplaceAllString(m, "<email>")
	m = cutPaths(m, reWinPath, "<path>")
	m = cutPaths(m, reUnixPath, "<path>")
	m = cutPaths(m, reRemote, "<remote>")
	for _, name := range names {
		if name != "" {
			m = replaceWord(m, name, "<remote>")
		}
	}
	m = reIP.ReplaceAllString(m, "<ip>")
	m = strings.Join(strings.Fields(m), " ")
	if utf8.RuneCountInString(m) > messageMax {
		m = string([]rune(m)[:messageMax]) + "…"
	}
	return m
}

func replaceWord(m, name, with string) string {
	var out strings.Builder
	for {
		i := strings.Index(m, name)
		if i < 0 {
			out.WriteString(m)
			return out.String()
		}
		end := i + len(name)
		before, _ := utf8.DecodeLastRuneInString(m[:i])
		after, _ := utf8.DecodeRuneInString(m[end:])
		out.WriteString(m[:i])
		if (i == 0 || !wordRune(before)) && (end == len(m) || !wordRune(after)) {
			out.WriteString(with)
		} else {
			out.WriteString(name)
		}
		m = m[end:]
	}
}

func wordRune(r rune) bool {
	return r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= 0x80
}
