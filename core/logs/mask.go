package logs

import (
	"bytes"
	"cmp"
	"encoding/json"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// Mask hides known secret values in records, such as a child's rc password or a serve's
// credentials. It hides each secret in every form that a line can contain: as is, URL-escaped as
// a query or a path, quoted the way Go quotes strings (rclone's %q) and JSON-escaped. It also
// hides each of those forms when it is JSON-escaped again, which is how a secret appears in a
// JSON line that wasn't decoded (such as one that was cut short).
type Mask struct {
	r *strings.Replacer
}

// NewMask returns a mask for the secrets, or nil when none is set. A secret is hidden however
// short it is, because a serve's password is chosen by the user, and a mask only applies to one
// child's lines.
func NewMask(secrets ...string) *Mask {
	var forms []string
	for _, s := range secrets {
		if s == "" {
			continue
		}
		for _, f := range escapes(s) {
			forms = append(forms, f)
			forms = append(forms, jsonEscapes(f)...)
		}
	}
	// Replace the longest forms first. When one secret is inside another (such as an item of a
	// list and the whole list), this keeps the rest of the longer one from showing.
	slices.SortFunc(forms, func(a, b string) int { return cmp.Or(len(b)-len(a), strings.Compare(a, b)) })
	forms = slices.Compact(forms)
	if len(forms) == 0 {
		return nil
	}
	pairs := make([]string, 0, 2*len(forms))
	for _, f := range forms {
		pairs = append(pairs, f, "***")
	}
	return &Mask{r: strings.NewReplacer(pairs...)}
}

func escapes(s string) []string {
	q := strconv.Quote(s)
	return append([]string{s, url.QueryEscape(s), url.PathEscape(s), q[1 : len(q)-1]}, jsonEscapes(s)...)
}

// jsonEscapes returns s as it appears inside a JSON string. There are two forms: encoding/json
// escapes <, > and &, and slog's JSON handler doesn't.
func jsonEscapes(s string) []string {
	var out []string
	for _, html := range []bool{true, false} {
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(html)
		if err := enc.Encode(s); err != nil {
			continue
		}
		j := strings.TrimSuffix(b.String(), "\n")
		out = append(out, j[1:len(j)-1])
	}
	return out
}

// Hide hides the secrets in r's message, object, source and extra values, in place.
func (m *Mask) Hide(r *Record) {
	if m != nil {
		rewrite(r, m.r.Replace)
	}
}
