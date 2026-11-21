package rclone

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/filter"
)

func TestOptionValues(t *testing.T) {
	ctx := context.Background()
	values := OptionValues(ctx)
	main := values["main"]
	// Keyed by rclone's option name, with each value written as rclone writes it.
	for name, want := range map[string]string{"ask_password": "false", "max_stats_groups": "100000", "log_level": "INFO"} {
		if main[name] != want {
			t.Errorf("main.%s = %q, want %q (all %v)", name, main[name], want, main)
		}
	}
	if _, ok := main["checkers"]; ok {
		t.Error("a default value is listed")
	}

	ci := fs.GetConfig(ctx)
	before := *ci
	t.Cleanup(func() {
		ci.Checkers, ci.ClientPass, ci.ConnectTimeout, ci.MaxTransfer = before.Checkers, before.ClientPass, before.ConnectTimeout, before.MaxTransfer
	})
	ci.Checkers, ci.ClientPass, ci.ConnectTimeout, ci.MaxTransfer = 16, "secret", fs.Duration(90*time.Second), 10<<20
	main = OptionValues(ctx)["main"]
	for name, want := range map[string]string{"checkers": "16", "contimeout": "1m30s", "max_transfer": "10Mi"} {
		if main[name] != want {
			t.Errorf("%s = %q, want %q", name, main[name], want)
		}
	}
	if _, ok := main["client_pass"]; ok {
		t.Error("a password is listed")
	}
}

// The value contract: a value is what a person types after the flag, a JSON number or switch is
// its literal text, and a list holds a list option's elements.
func TestParseOption(t *testing.T) {
	for _, c := range []struct {
		name     string
		template any
		v        any
		want     any
	}{
		{"a size's text", fs.SizeSuffix(0), "10M", fs.SizeSuffix(10 << 20)},
		{"a bare size is KiB, as --buffer-size 1000 is", fs.SizeSuffix(0), json.Number("1000"), fs.SizeSuffix(1000 << 10)},
		{"a size in bytes", fs.SizeSuffix(0), "1234567B", fs.SizeSuffix(1234567)},
		{"a size off", fs.SizeSuffix(0), "off", fs.SizeSuffix(-1)},
		{"a duration", fs.Duration(0), "5m", fs.Duration(5 * time.Minute)},
		{"a bare duration is seconds", fs.Duration(0), json.Number("90"), fs.Duration(90 * time.Second)},
		{"a duration off", fs.Duration(0), "off", fs.DurationOff},
		{"a switch", false, true, true},
		{"a switch's text", false, "false", false},
		{"a tristate", fs.Tristate{}, true, fs.Tristate{Valid: true, Value: true}},
		{"a tristate unset", fs.Tristate{}, "unset", fs.Tristate{}},
		{"a number", 0, json.Number("8"), 8},
		{"a float", 0.0, json.Number("0.5"), 0.5},
		{"a Go number", 0, 16, 16},
		{"a repeated flag's one text, kept whole", []string(nil), "*.{jpg,png}", []string{"*.{jpg,png}"}},
		{"a repeated flag's list", []string(nil), []any{"a", "b,c"}, []string{"a", "b,c"}},
		{"a comma list's text, split by rclone", fs.CommaSepList(nil), `a,"b,c"`, fs.CommaSepList{"a", "b,c"}},
		{"a comma list's elements", fs.CommaSepList(nil), []any{"a,b"}, fs.CommaSepList{"a,b"}},
		{"an argv's text, split by rclone", fs.SpaceSepList(nil), `"/opt/my mapper" --flag 'a b'`, fs.SpaceSepList{"/opt/my mapper", "--flag", "'a", "b'"}},
		{"an argv's elements", fs.SpaceSepList(nil), []string{"/opt/my mapper", "-v"}, fs.SpaceSepList{"/opt/my mapper", "-v"}},
		{"an empty list", []string{"x"}, []any{}, []string{}},
		{"no default", nil, "text", "text"},
	} {
		got, err := ParseOption(c.template, c.v)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %#v, %v; want %#v", c.name, got, err, c.want)
		}
	}
	for _, c := range []struct {
		name     string
		template any
		v        any
		want     string
	}{
		{"a list for one value", 0, []any{"1"}, "takes one value, not a list"},
		{"an object", "", map[string]any{"a": 1}, "takes a text"},
		{"a nested list", []string(nil), []any{[]any{"a"}}, "takes a text"},
		{"a number with a point for an int", 0, json.Number("8.0"), "8.0"},
		{"a word for a size", fs.SizeSuffix(0), "lots", "lots"},
		{"a yes for a switch", false, "yes", "yes"},
	} {
		if _, err := ParseOption(c.template, c.v); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error with %q", c.name, err, c.want)
		}
	}
}

// The default of every main and filter option, typed as its flag, parses the way that flag
// parses it. The option itself is the flag's value (flags.AddFlagsFromOptions), so ParseOption
// and the flag agree on every type rclone has.
func TestParseOptionIsTheFlags(t *testing.T) {
	for _, block := range []string{"main", "filter", "vfs", "mount"} {
		for i := range fs.OptionsRegistry[block].Options {
			o := &fs.OptionsRegistry[block].Options[i]
			text := defaultTextOf(o)
			if text == "" {
				continue
			}
			flag := o.Copy()
			flag.Value = nil
			if err := flag.Set(text); err != nil {
				t.Errorf("%s.%s: the flag refuses its own default %q: %v", block, o.Name, text, err)
				continue
			}
			got, err := ParseOption(o.Default, text)
			if err != nil || !reflect.DeepEqual(got, flag.GetValue()) {
				t.Errorf("%s.%s: %q reads as %#v (%v), the flag's %#v", block, o.Name, text, got, err, flag.GetValue())
			}
		}
	}
}

func defaultTextOf(o *fs.Option) string {
	c := o.Copy()
	c.Value = nil
	return c.String()
}

// Only the named fields are set, with their values unchanged. A value of the wrong type is
// refused instead of causing a panic.
func TestSetFields(t *testing.T) {
	var fo filter.Options
	fo.MaxAge = fs.Duration(time.Hour)
	if err := SetFields(&fo, map[string]any{"max_size": fs.SizeSuffix(1000), "metadata_include": []string{"k=v"}}); err != nil {
		t.Fatal(err)
	}
	if fo.MaxSize != 1000 || !slices.Equal(fo.MetaRules.IncludeRule, []string{"k=v"}) || fo.MaxAge != fs.Duration(time.Hour) {
		t.Errorf("%+v", fo)
	}
	if err := SetFields(&fo, map[string]any{"max_size": "1000"}); err == nil {
		t.Error("a text set on a size")
	}
}

func TestSecretOptions(t *testing.T) {
	for name, want := range map[string]bool{
		"pass": true, "client_pass": true, "auth_key": true, "salt": true, "key": true, "token": true,
		"checkers": false, "passive": false, "keep_alive": false, "user": false,
	} {
		if got := secret(fs.Option{Name: name, Default: ""}); got != want {
			t.Errorf("secret(%s) = %v", name, got)
		}
	}
	if secret(fs.Option{Name: "ask_password", Default: true}) {
		t.Error("a switch is secret")
	}
	if !secret(fs.Option{Name: "x", IsPassword: true}) || !secret(fs.Option{Name: "y", Sensitive: true}) {
		t.Error("rclone's own marks are not secret")
	}
}

// Every name is still an option in rclone's main block, listed once. An upgrade that renames
// one fails here.
func TestNotPerOperationNamesExist(t *testing.T) {
	main := fs.OptionsRegistry["main"].Options
	for i, name := range NotPerOperation {
		if main.Get(name) == nil {
			t.Errorf("%s is not an option of rclone's main block", name)
		}
		if slices.Contains(NotPerOperation[:i], name) {
			t.Errorf("%s is listed twice", name)
		}
		if PerOperation(name) {
			t.Errorf("%s is per operation", name)
		}
	}
	if !PerOperation("transfers") {
		t.Error("transfers is not per operation")
	}
}

// The serve types come from rclone's own list for this build. Each has its option block, and
// nfs is there only on Unix.
func TestServeTypes(t *testing.T) {
	types := ServeTypes()
	want := []string{"dlna", "ftp", "http", "restic", "s3", "sftp", "webdav"}
	if _, nfs := fs.OptionsRegistry["nfs"]; nfs {
		want = []string{"dlna", "ftp", "http", "nfs", "restic", "s3", "sftp", "webdav"}
	}
	if !slices.Equal(types, want) {
		t.Errorf("serve types %v, want %v", types, want)
	}
	for _, typ := range types {
		if _, ok := fs.OptionsRegistry[typ]; !ok {
			t.Errorf("serve %s has no option block", typ)
		}
	}
	types[0] = "changed"
	if ServeTypes()[0] == "changed" {
		t.Error("the list is shared")
	}
}
