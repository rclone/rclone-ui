package logs

import (
	"encoding/json"
	"regexp"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
)

// connParam matches one parameter of an on-the-fly remote or a connection string, such as
// `:s3,secret_access_key=…:bucket` or `remote,pass="a,b":path`. The value is either quoted with
// " or ' (a doubled quote inside stands for one quote), or runs to the next comma or colon
// (see fs/fspath).
var connParam = regexp.MustCompile(`,([A-Za-z0-9_-]+)=("(?:[^"]|"")*"|'(?:[^']|'')*'|[^,:\s]*)`)

// userinfo matches a password in a URL (scheme://user:password@host), which the url of an http
// or webdav remote may contain.
var userinfo = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]*:)[^/\s@]+@`)

// sensitive holds the names of backend options marked IsPassword or Sensitive. It is built on
// the first call to Redact rather than when the package is initialised, because the backends
// register in their own init functions, which may run after this package's.
var sensitive = sync.OnceValue(func() map[string]bool {
	m := map[string]bool{}
	for _, ri := range fs.Registry {
		for _, o := range ri.Options {
			if o.IsPassword || o.Sensitive {
				m[o.Name] = true
			}
		}
	}
	return m
})

// Redact hides the credentials that a line may contain as part of a remote's name: the value of
// every connection string parameter that is a password or a secret, and any password in a URL.
// rclone hides what it knows is secret in its own output, but a remote's name is plain text and
// is printed in full, in rclone's lines, in a child's lines and in the app's own.
func Redact(s string) string {
	if strings.Contains(s, "=") {
		s = connParam.ReplaceAllStringFunc(s, func(m string) string {
			name := connParam.FindStringSubmatch(m)[1]
			if secret(name) {
				return "," + name + "=***"
			}
			return m
		})
	}
	if strings.Contains(s, "://") {
		s = userinfo.ReplaceAllString(s, "${1}***@")
	}
	return s
}

// secret reports whether a parameter's value must be hidden. That is the case for an option a
// backend marks as secret, and for a name containing a word such as pass, secret, token, key or
// salt (the same words core/rclone uses). The word check covers the options of backends that
// aren't linked in. Headers and cookies are hidden too, because the headers option of http and
// webdav can contain an Authorization header, and neither option is marked.
func secret(name string) bool {
	name = strings.ToLower(strings.ReplaceAll(name, "-", "_"))
	if sensitive()[name] {
		return true
	}
	for part := range strings.SplitSeq(name, "_") {
		switch part {
		case "pass", "password", "secret", "token", "key", "salt", "headers", "cookie", "cookies":
			return true
		}
	}
	return false
}

func redact(r *Record) { rewrite(r, Redact) }

// rewrite runs fn over all of r's text: its message, object, source and extra values.
func rewrite(r *Record, fn func(string) string) {
	r.Message = fn(r.Message)
	r.Object = fn(r.Object)
	r.Source = fn(r.Source)
	rewriteMap(r.Extra, fn)
}

// rewriteMap rewrites m's values in place. This is safe because each record has its own map,
// made by Record.add or when a child's line is decoded.
func rewriteMap(m map[string]any, fn func(string) string) {
	for k, v := range m {
		m[k] = rewriteValue(v, fn)
	}
}

func rewriteValue(v any, fn func(string) string) any {
	switch x := v.(type) {
	case string:
		return fn(x)
	case json.RawMessage:
		s := string(x)
		red := fn(s)
		if red == s {
			return x
		}
		// An unquoted value runs to the next comma or colon, so the replacement can remove a
		// JSON string's closing quote. A value that is no longer valid JSON is kept as text.
		if json.Valid([]byte(red)) {
			return json.RawMessage(red)
		}
		return red
	case map[string]any:
		rewriteMap(x, fn)
	case []any: // a child's JSON line
		for i, e := range x {
			x[i] = rewriteValue(e, fn)
		}
	}
	return v
}
