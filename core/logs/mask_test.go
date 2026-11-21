package logs

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestMaskHidesEveryForm(t *testing.T) {
	const secret = `p"a s&<\/>`
	m := NewMask("", secret, "ab")
	hidden := func(m *Mask, s string) string {
		r := Record{Message: s}
		m.Hide(&r)
		return r.Message
	}
	jsonOf := func(s string) string {
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		return string(b[1 : len(b)-1])
	}
	quoted := strconv.Quote(secret)
	quoted = quoted[1 : len(quoted)-1]
	for _, form := range []string{
		secret, url.QueryEscape(secret), url.PathEscape(secret), quoted, jsonOf(secret),
		jsonOf(quoted), jsonOf(url.QueryEscape(secret)),
		`p\"a s&<\\/>`, // slog's JSON leaves <, > and & as they are
		"ab",
	} {
		if got := hidden(m, "before "+form+" after"); got != "before *** after" {
			t.Errorf("%q: %q", form, got)
		}
	}
	if got := hidden(m, "nothing secret"); got != "nothing secret" {
		t.Errorf("a line with no secret: %q", got)
	}

	if NewMask("", "") != nil {
		t.Error("a mask of no secret")
	}
	var none *Mask
	if hidden(none, "ab") != "ab" {
		t.Error("a nil mask changed something")
	}
}

func TestMaskHidesEveryTextOfARecord(t *testing.T) {
	m := NewMask("hunter2")
	r := Record{
		Message: "pass hunter2", Object: "/hunter2/f", Source: "x hunter2",
		Extra: map[string]any{"a": "hunter2", "nested": map[string]any{"list": []any{"ok", `"hunter2"`}}},
	}
	m.Hide(&r)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "hunter2") {
		t.Errorf("the record still has the secret: %s", b)
	}
	if r.Message != "pass ***" || r.Object != "/***/f" {
		t.Errorf("record %+v", r)
	}
}
