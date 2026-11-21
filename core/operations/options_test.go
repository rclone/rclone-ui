package operations

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/filter"

	"github.com/rclone/rclone-ui/core/errs"
)

// A plan stores each value as text, as the page gave it, and a list option as the elements that
// rclone parsed. rclone gets the same value that the same flag on its command line would give.
func TestStoredTexts(t *testing.T) {
	o, err := decodeOptions(json.RawMessage(`{"max_size": "1234567B", "min_size": 1000, "max_age": "1h",
		"min_age": 90, "exclude": "*.{jpg,png}", "files_from0": "/lists/a,b.txt", "include": ["a", "b,c"],
		"ignore_case": true}`))
	if err != nil {
		t.Fatal(err)
	}
	stored, err := storedOptions(blockFilter, o)
	if err != nil {
		t.Fatal(err)
	}
	want := Options{
		"max_size": "1234567B", "min_size": "1000", "max_age": "1h", "min_age": "90", "ignore_case": "true",
		"exclude": []any{"*.{jpg,png}"}, "files_from0": []any{"/lists/a,b.txt"}, "include": []any{"a", "b,c"},
	}
	if !reflect.DeepEqual(stored, want) {
		t.Errorf("stored\n got %v\nwant %v", stored, want)
	}
	// Stored as JSON and read back, as the ledger does.
	raw, _ := json.Marshal(stored)
	var back Options
	if err := decodeJSON(raw, &back); err != nil {
		t.Fatal(err)
	}
	var fo filter.Options
	if err := setOptions(blockFilter, back, &fo); err != nil {
		t.Fatal(err)
	}
	if fo.MaxSize != 1234567 || fo.MinSize != 1000<<10 || fo.MaxAge != fs.Duration(time.Hour) ||
		fo.MinAge != fs.Duration(90*time.Second) || !fo.IgnoreCase ||
		!reflect.DeepEqual(fo.ExcludeRule, []string{"*.{jpg,png}"}) ||
		!reflect.DeepEqual(fo.FilesFrom0, []string{"/lists/a,b.txt"}) ||
		!reflect.DeepEqual(fo.IncludeRule, []string{"a", "b,c"}) {
		t.Errorf("filter options %+v", fo)
	}

	// rclone splits the text of a comma list or an argv, and the elements are stored.
	o, _ = decodeOptions(json.RawMessage(`{"metadata_mapper": "\"/opt/my mapper\" --flag 'a b'", "order_by": "size,desc", "checkers": 8}`))
	stored, err = storedOptions(blockMain, o)
	if err != nil {
		t.Fatal(err)
	}
	want = Options{"metadata_mapper": []any{"/opt/my mapper", "--flag", "'a", "b'"}, "order_by": "size,desc", "checkers": "8"}
	if !reflect.DeepEqual(stored, want) {
		t.Errorf("stored\n got %v\nwant %v", stored, want)
	}
	var ci fs.ConfigInfo
	if err := setOptions(blockMain, stored, &ci); err != nil {
		t.Fatal(err)
	}
	if ci.Checkers != 8 || ci.OrderBy != "size,desc" || len(ci.MetadataMapper) != 4 {
		t.Errorf("config %+v", ci)
	}
}

// Values that rclone refuses are reported with rclone's error and the option's name.
func TestStoredRefusals(t *testing.T) {
	for _, c := range []struct{ json, want string }{
		{`{"max_age": "soon"}`, "max_age: parsing \"soon\" as fs.Duration failed"},
		{`{"max_size": "lots"}`, "max_size"},
		{`{"ignore_case": "yes"}`, "ignore_case"},
		{`{"max_size": {"bytes": 1}}`, "max_size: takes a text, a number or a switch"},
		{`{"max_size": [1]}`, "max_size: takes one value, not a list"},
	} {
		o, err := decodeOptions(json.RawMessage(c.json))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storedOptions(blockFilter, o); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.json, err, c.want)
		}
	}
}

// Values that rclone's Reload would refuse or raise to a minimum are refused, with the option's
// name where there is one, because a plan's options never go through Reload. interactive is
// refused because it would wait forever for a terminal.
func TestReloadRules(t *testing.T) {
	for _, tc := range []struct {
		json    string
		field   string // the refused field, or "" for the whole form
		refused bool
	}{
		{`{"transfers": 0}`, "transfers", true},
		{`{"transfers": -3}`, "transfers", true},
		{`{"checkers": "0"}`, "checkers", true},
		{`{"retries": 0}`, "retries", true},
		{`{"low_level_retries": 0}`, "low_level_retries", true},
		{`{"compare_dest": "gdrive:old", "copy_dest": ["gdrive:older"]}`, "", true},
		{`{"partial_suffix": ".partial-12345678"}`, "partial_suffix", true},
		{`{"interactive": true}`, "interactive", true},
		{`{"transfers": 1}`, "", false},
		{`{"compare_dest": "gdrive:old"}`, "", false},
		{`{"compare_dest": "gdrive:old", "copy_dest": ""}`, "", false},
		{`{"partial_suffix": ".partial-1234567"}`, "", false},
		{`{"interactive": false}`, "", false},
	} {
		o, err := decodeOptions(json.RawMessage(tc.json))
		if err != nil {
			t.Fatal(err)
		}
		_, err = storedOptions(blockMain, o)
		switch {
		case !tc.refused && err != nil:
			t.Errorf("%s: %v", tc.json, err)
		case tc.refused && (err == nil || !errs.Is(err) || errs.FieldOf(err) != tc.field):
			t.Errorf("%s: %v (field %q), want a refusal of %q", tc.json, err, errs.FieldOf(err), tc.field)
		}
	}
}
