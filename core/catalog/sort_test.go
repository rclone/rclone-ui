package catalog

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

func TestSortOptions(t *testing.T) {
	options := Group{
		"transfers":       json.RawMessage(`4`),
		"--dry-run":       json.RawMessage(`true`),
		"max-depth":       json.RawMessage(`2`),
		"ignore_existing": json.RawMessage(`true`),
		"max_delete":      json.RawMessage(`10`),
		"exclude":         json.RawMessage(`["*.tmp"]`),
		"metadata":        json.RawMessage(`true`),
		"vfs_cache_mode":  json.RawMessage(`"full"`),
		"allow_other":     json.RawMessage(`true`),
		"addr":            json.RawMessage(`":8080"`),
		"bwlimit":         json.RawMessage(`"1M"`),
		"stats_one_line":  json.RawMessage(`true`),
		"log_file":        json.RawMessage(`"/tmp/x.log"`),
		"no_such_option":  json.RawMessage(`1`),
	}
	got := SortOptions(options, "")
	names := func(group string) []string {
		var out []string
		for name := range got.Groups[group] {
			out = append(out, name)
		}
		return out
	}
	for group, want := range map[string][]string{
		// A main option that a run can set, but no group lists, goes to config, under rclone's
		// name.
		"config":   {"dry_run", "max_depth", "transfers"},
		"copy":     {"ignore_existing"},
		"sync":     {"max_delete"},
		"filter":   {"exclude"},
		"metadata": {"metadata"},
		"vfs":      {"vfs_cache_mode"},
		"mount":    {"allow_other"},
	} {
		if g := names(group); !sameSet(g, want) {
			t.Errorf("%s: %v, want %v", group, g, want)
		}
	}
	// Without a serve type, a serve option goes into the group of each serve that has it.
	for _, serve := range []string{"serve.http", "serve.webdav", "serve.ftp"} {
		if _, ok := got.Groups[serve]["addr"]; !ok {
			t.Errorf("addr is not in %s: %v", serve, got.Groups)
		}
	}
	if got.Groups["config"]["dry_run"] == nil || string(got.Groups["config"]["dry_run"]) != "true" {
		t.Errorf("the value of dry_run: %s", got.Groups["config"]["dry_run"])
	}
	why := map[string]string{}
	for _, s := range got.Skipped {
		why[s.Flag] = s.Reason
	}
	if want := map[string]string{
		"bwlimit":        reasonSettings.String(),
		"stats_one_line": reasonCLI.String(),
		"log_file":       reasonNoGroup.String(),
		"no_such_option": reasonUnknown.String(),
	}; !reflect.DeepEqual(why, want) {
		t.Errorf("skipped %v, want %v", why, want)
	}

	// With a serve type, a serve option goes into that serve's group alone, and an option that
	// only another serve has is skipped.
	got = SortOptions(Group{"addr": json.RawMessage(`":8080"`), "announce_interval": json.RawMessage(`"5m"`)}, "webdav")
	if len(got.Groups) != 1 || got.Groups["serve.webdav"]["addr"] == nil {
		t.Errorf("groups of a webdav serve: %v", got.Groups)
	}
	if len(got.Skipped) != 1 || got.Skipped[0].Reason != reasonNoGroup.String() {
		t.Errorf("skipped of a webdav serve: %v", got.Skipped)
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	in := map[string]bool{}
	for _, s := range a {
		in[s] = true
	}
	for _, s := range b {
		if !in[s] {
			return false
		}
	}
	return true
}

// The reasons reach the page in the app's language. The pseudo-language shows that they are
// translated, whether or not a language has their translation yet. rclone's own reason keeps its
// words.
func TestLocalSkipped(t *testing.T) {
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	a := NewAPI(New(""), nil)
	i18n.SetLanguage(i18n.Pseudo)
	sorted, _ := a.SortOptions(context.Background(), Group{"no_such_option": json.RawMessage(`1`)}, "")
	if len(sorted.Skipped) != 1 || !strings.HasPrefix(sorted.Skipped[0].Reason, "[") {
		t.Errorf("SortOptions' reason isn't translated: %v", sorted.Skipped)
	}
	parsed, err := a.ParseCommand(context.Background(), `sync a: b: --no-such-flag --max-size nope`)
	if err != nil {
		t.Fatal(err)
	}
	why := map[string]string{}
	for _, s := range parsed.Skipped {
		why[s.Flag] = s.Reason
	}
	if !strings.HasPrefix(why["--no-such-flag"], "[") || why["--max-size"] == "" || strings.HasPrefix(why["--max-size"], "[") {
		t.Errorf("ParseCommand's reasons: %v", why)
	}
	i18n.SetLanguage(i18n.English)
	if got := LocalSkipped([]SkippedFlag{Skip("--x", reasonCLI)}); got[0].Reason != reasonCLI.String() {
		t.Errorf("English reason %q", got[0].Reason)
	}
	if got := LocalSkipped(nil); got == nil {
		t.Error("a nil list stays nil")
	}
}
