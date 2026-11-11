package deeplink

import (
	"net/url"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		raw       string
		ok        bool
		cmd, name string
	}{
		{"rclone://add-template?cmd=copy%20--fast-list&name=Nightly", true, "copy --fast-list", "Nightly"},
		{"rclone:add-template?cmd=sync", true, "sync", ""},
		{"rclone:///add-template/?cmd=x&name=%20%20", true, "x", ""},
		{"RCLONE://Add-Template?name=only", true, "", "only"},
		{"rclone://add-template", true, "", ""},
		{"rclone://something-else?x=1", false, "", ""},
		{"https://add-template?cmd=x", false, "", ""},
		{"", false, "", ""},
	}
	for _, c := range cases {
		l, ok := Parse(c.raw)
		if ok != c.ok {
			t.Errorf("Parse(%q) ok = %v, want %v", c.raw, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		u, err := url.Parse(l.URL)
		if err != nil || u.Path != "/templates" {
			t.Errorf("Parse(%q).URL = %q", c.raw, l.URL)
			continue
		}
		q := u.Query()
		if q.Get("action") != "add" || q.Get("cmd") != c.cmd || q.Get("name") != c.name {
			t.Errorf("Parse(%q) query = %v, want cmd %q name %q", c.raw, q, c.cmd, c.name)
		}
		if _, has := q["name"]; has && c.name == "" {
			t.Errorf("Parse(%q) kept an empty name", c.raw)
		}
	}
}

func TestFromArgs(t *testing.T) {
	if got := FromArgs([]string{"--flag", "rclone://add-template?cmd=x"}); got != "rclone://add-template?cmd=x" {
		t.Errorf("FromArgs = %q", got)
	}
	if got := FromArgs([]string{"ui", "--data-dir", "/x"}); got != "" {
		t.Errorf("FromArgs found %q", got)
	}
}

func TestUpdateLink(t *testing.T) {
	for _, c := range []struct{ version, channel string }{{"4.0.2", "stable"}, {"", "beta"}, {"", ""}} {
		raw := UpdateLink(c.version, c.channel)
		if !IsLink(raw) {
			t.Fatalf("%q is not a link", raw)
		}
		link, ok := Parse(raw)
		if !ok || link.Update == nil || link.URL != "" {
			t.Fatalf("Parse(%q) = %+v, %v", raw, link, ok)
		}
		if link.Update.Version != c.version || link.Update.Channel != c.channel {
			t.Errorf("Parse(%q) = %+v", raw, *link.Update)
		}
	}
}
