package config

import (
	"strings"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// CheckText checks a config file's text before the editor saves it. It reads the text with the
// grammar of goconfig, the parser that rclone's config file uses, so a line that rclone would
// reject or misread is refused with its number. Each section's name must be one rclone accepts,
// and the text can't hold a NUL. Errors name the line, never its text, which may hold a secret.
// An empty text is valid: it is a config without remotes. The error is on the "text" field.
func CheckText(text string) error {
	text = strings.TrimPrefix(text, "\uFEFF")
	current := ""
	for i, line := range strings.Split(text, "\n") {
		n := i + 1
		if strings.ContainsRune(line, 0) {
			return errs.Field("text", "line %d: it holds a NUL character, which a config can't hold", n)
		}
		line = strings.TrimSpace(line)
		switch {
		case line == "" || line[0] == '#' || line[0] == ';':
			continue
		case line[0] == '[' && line[len(line)-1] == ']':
			current = strings.TrimSpace(line[1 : len(line)-1])
			if current == "" {
				return errs.Field("text", "line %d: a section needs a name", n)
			}
			if problem := rclone.CheckRemoteName("text", current); problem != nil {
				// i18n: A line of the config file, the remote's name on it, and why that name can't be used.
				return errs.Field("text", "line %d: [%s]: %s", n, current, problem)
			}
			continue
		case current == "":
			// i18n: "[section]" is the syntax of a config file, as in [gdrive].
			return errs.Field("text", "line %d: a key before the first [section]", n)
		}
		if !keyValue(line) {
			// i18n: "[section]" and "key = value" are the syntax of a config file.
			return errs.Field("text", "line %d: expected [section] or key = value", n)
		}
	}
	return nil
}

// keyValue reports whether a line is a key and a value, by goconfig's rule. The key may be
// quoted with ", ` or """, and a value in ` or """ must be closed.
func keyValue(line string) bool {
	var sep int
	if q := leadingQuote(line); q != "" {
		end := strings.Index(line[len(q):], q)
		if end < 0 {
			return false
		}
		end += len(q)
		sep = strings.IndexAny(line[end:], "=:")
		if sep <= 0 {
			return false
		}
		sep += end
		if line[len(q):end] == "" {
			return false
		}
	} else {
		sep = strings.IndexAny(line, "=:")
		if sep <= 0 || strings.TrimSpace(line[:sep]) == "" {
			return false
		}
	}
	rest := strings.TrimSpace(line[sep+1:])
	if quoted(rest) {
		q := "`"
		if rest[0] == '"' {
			q = `"""`
		}
		return strings.LastIndex(rest[len(q):], q) >= 0
	}
	return true
}

// quoted is goconfig's test for a value in quotes.
func quoted(v string) bool {
	return len(v) >= 2 && v[0] == '`' || len(v) >= 6 && strings.HasPrefix(v, `"""`)
}

func leadingQuote(line string) string {
	switch {
	case len(line) >= 6 && strings.HasPrefix(line, `"""`):
		return `"""`
	case line[0] == '"':
		return `"`
	case line[0] == '`':
		return "`"
	}
	return ""
}
