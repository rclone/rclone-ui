package templates

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

func names(ts []*Template) []string {
	var out []string
	for _, t := range ts {
		out = append(out, t.Name)
	}
	return out
}

func TestSaveListReplaceDelete(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	a, err := s.Save(ctx, &Template{Name: " Fast ", Tags: []operations.Operation{"copy", "copy", "sync"}, Options: opts(`{"transfers": 16}`)})
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == "" || a.Name != "Fast" || !slices.Equal(a.Tags, []operations.Operation{"copy", "sync"}) {
		t.Errorf("saved %v", a)
	}
	b, err := s.Save(ctx, &Template{ID: "b", Name: "Photos"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Options == nil || len(b.Options) != 0 {
		t.Errorf("normalised %v", b)
	}
	// Replacing keeps the place in the list.
	a.Name = "Faster"
	if _, err := s.Save(ctx, a); err != nil {
		t.Fatal(err)
	}
	all, err := s.List(ctx)
	if err != nil || !slices.Equal(names(all), []string{"Faster", "Photos"}) {
		t.Fatalf("list %v %v", names(all), err)
	}
	// The saved templates read back as Check normalized them.
	if got := all[0]; got.ID != a.ID || text(got.Options) != `{"transfers":16}` || !slices.Equal(got.Tags, []operations.Operation{"copy", "sync"}) {
		t.Errorf("read back %v", got)
	}
	if got := all[1]; got.ID != "b" || text(got.Options) != "{}" || len(got.Tags) != 0 {
		t.Errorf("read back %v", got)
	}
	if n, err := s.Delete(ctx, []string{"b", "missing"}); err != nil || n != 1 {
		t.Errorf("Delete: %d %v", n, err)
	}
	if all, err := s.List(ctx); err != nil || !slices.Equal(names(all), []string{"Faster"}) {
		t.Errorf("after Delete: %v %v", names(all), err)
	}
}

func TestRefusals(t *testing.T) {
	for _, c := range []struct {
		t     *Template
		field string
	}{
		{&Template{Name: ""}, "name"},
		{&Template{ID: "no spaces", Name: "x"}, "id"},
		{&Template{Name: "x", Tags: []operations.Operation{"format"}}, "tags"},
		{&Template{Name: "x", Options: catalog.Group{"transfers": json.RawMessage(`{nope`)}}, "options"},
	} {
		_, err := Check(c.t)
		var inv *errs.FieldError
		if !errors.As(err, &inv) || inv.Field != c.field {
			t.Errorf("Check(%v) = %v, want a refusal of %s", c.t, err, c.field)
		}
	}
}

// A template stores the app's own metadata mapper as the mapping panel writes it, however it was
// typed. A mapper without `metadata` is refused, as a start would refuse it.
func TestSaveStoresTheMapper(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	saved, err := s.Save(ctx, &Template{Name: "Map", Tags: []operations.Operation{"copy", "mount"},
		Options: opts(`{"metadata": true, "metadata_mapper": "metadata-map --map \"a b=c\""}`)})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(saved.Options["metadata_mapper"]); got != `["metadata-map","--map","a b=c"]` {
		t.Errorf("stored %s", got)
	}
	_, err = s.Save(ctx, &Template{Name: "No metadata", Tags: []operations.Operation{"mount"},
		Options: opts(`{"metadata_mapper": ["metadata-map"]}`)})
	if errs.FieldOf(err) != "options" {
		t.Errorf("a mapper without metadata: %v", err)
	}
}

// A template keeps its paths without blank sources and with the destination trimmed. A template
// without paths stores none.
func TestPaths(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	saved, err := s.Save(ctx, &Template{ID: "p", Name: "Photos", Tags: []operations.Operation{"copy"},
		Paths: &Paths{Sources: []string{"", "src:x ", "  ", "/b"}, Destination: "  dst:backup "}})
	if err != nil {
		t.Fatal(err)
	}
	want := Paths{Sources: []string{"src:x ", "/b"}, Destination: "dst:backup"}
	if saved.Paths == nil || !reflect.DeepEqual(*saved.Paths, want) {
		t.Errorf("saved %+v, want %+v", saved.Paths, want)
	}
	for _, blank := range []*Paths{nil, {}, {Sources: []string{" "}, Destination: " "}} {
		if _, err := s.Save(ctx, &Template{ID: "none", Name: "None", Paths: blank}); err != nil {
			t.Fatal(err)
		}
		got, err := s.Get(ctx, "none")
		if err != nil || got.Paths != nil {
			t.Errorf("%+v saved as %+v %v, want no paths", blank, got, err)
		}
	}
	var stored sql.NullString
	if err := s.db.R.QueryRow(`SELECT paths FROM templates WHERE id = 'none'`).Scan(&stored); err != nil || stored.Valid {
		t.Errorf("stored %v %v, want NULL", stored, err)
	}
	all, err := s.List(ctx)
	if err != nil || len(all) != 2 || all[0].Paths == nil || !reflect.DeepEqual(*all[0].Paths, want) {
		t.Fatalf("listed %+v %v", all, err)
	}
	// Only a destination is kept too, with an empty list of sources.
	only, err := s.Save(ctx, &Template{ID: "dest", Name: "Dest", Paths: &Paths{Destination: "dst:"}})
	if err != nil || only.Paths == nil || len(only.Paths.Sources) != 0 || only.Paths.Sources == nil {
		t.Errorf("only a destination: %+v %v", only.Paths, err)
	}
	if _, err := s.Get(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get of a missing template: %v", err)
	}
}

func TestPathRefusals(t *testing.T) {
	for _, p := range []*Paths{
		{Sources: []string{"src:x", "-src:y"}},
		{Destination: "-dst:x"},
	} {
		_, err := Check(&Template{Name: "x", Paths: p})
		var inv *errs.FieldError
		if !errors.As(err, &inv) || inv.Field != "paths" {
			t.Errorf("Check(%+v) = %v, want a refusal of paths", p, err)
		}
	}
	// A mount point on Windows can be a drive letter or *.
	for _, dest := range []string{"M:", "*"} {
		if _, err := Check(&Template{Name: "x", Tags: []operations.Operation{"mount"}, Paths: &Paths{Sources: []string{"src:"}, Destination: dest}}); err != nil {
			t.Errorf("mount point %s: %v", dest, err)
		}
	}
}

// Saving checks the options against the template's tags, as their starts would: an option that
// none of them takes is refused.
func TestOptionsCheckedForEachTag(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	for _, c := range []struct {
		tags    []operations.Operation
		options string
		want    string
	}{
		{[]operations.Operation{"copy", "sync"}, `{"transfers": 4, "max_age": "1d", "metadata": true}`, ""},
		{[]operations.Operation{"mount", "serve"}, `{"vfs_cache_mode": "full", "no_such": 1}`, ""},
		// An option that only one of the tags takes is kept: the copy's run leaves it out.
		{[]operations.Operation{"copy", "mount"}, `{"vfs_cache_mode": "full"}`, ""},
		{[]operations.Operation{"copy", "delete"}, `{"vfs_cache_mode": "full"}`, "Copy: vfs_cache_mode is not one of the options rclone takes here."},
		{[]operations.Operation{"move"}, `{"--transfers": 4}`, "Move: --transfers is written transfers here."},
		{[]operations.Operation{"purge"}, `{"no_such": 1}`, "Purge: no_such is not one of the options rclone takes here."},
		{[]operations.Operation{"bisync"}, `{"bwlimit": "1M"}`, "bwlimit can't be set for one transfer"},
		// A cleared value is left out, as a start leaves it out.
		{[]operations.Operation{"copy"}, `{"vfs_cache_mode": null, "no_such": " "}`, ""},
	} {
		_, err := s.Save(ctx, &Template{Name: "x", Tags: c.tags, Options: opts(c.options)})
		if c.want == "" {
			if err != nil {
				t.Errorf("%v %s: %v", c.tags, c.options, err)
			}
			continue
		}
		var inv *errs.FieldError
		if !errors.As(err, &inv) || inv.Field != "options" || !strings.HasPrefix(inv.Message, c.want) {
			t.Errorf("%v %s: %v, want %q on options", c.tags, c.options, err, c.want)
		}
	}
}

// A template runs as one of its tags with its paths and options, sorted into the form's groups.
func TestRunArgs(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	for _, tmpl := range []*Template{
		{ID: "copy", Name: "Copy", Tags: []operations.Operation{"copy", "delete"},
			Options: opts(`{"transfers": 4, "max_age": "1d"}`), Paths: &Paths{Sources: []string{"src:x", "src:y"}, Destination: "dst:"}},
		{ID: "one", Name: "One", Tags: []operations.Operation{"sync", "purge"}, Options: opts(`{"checksum": true}`),
			Paths: &Paths{Sources: []string{"src:x"}, Destination: "dst:"}},
		{ID: "bare", Name: "Bare", Tags: []operations.Operation{"copy"}},
		{ID: "mount", Name: "Mount", Tags: []operations.Operation{"mount"}, Paths: &Paths{Sources: []string{"src:x"}, Destination: "/mnt"}},
	} {
		if _, err := s.Save(ctx, tmpl); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		id            string
		tag           operations.Operation
		want, refused string
	}{
		{"copy", "copy", `{"sources":["src:x","src:y"],"destination":"dst:","options":{"filter":{"max_age":"1d"},"config":{"transfers":4}}}`, ""},
		{"one", "sync", `{"source":"src:x","destination":"dst:","options":{"sync":{"checksum":true}}}`, ""},
		{"one", "purge", `{"sources":["src:x"],"options":{"config":{"checksum":true}}}`, ""},
		{"copy", "move", "", "This template has no paths to run for this operation: apply it in its form."},
		{"bare", "copy", "", "This template has no paths to run for this operation: apply it in its form."},
		{"mount", "mount", "", "A template does not run mount: apply it in its form."},
		{"missing", "copy", "", "This template no longer exists."},
	} {
		got, err := s.RunArgs(ctx, c.id, c.tag)
		if c.refused != "" {
			if errs.Of(err) == nil || err.Error() != c.refused {
				t.Errorf("%s as %s: %+v %v, want %q", c.id, c.tag, got, err, c.refused)
			}
			continue
		}
		raw, _ := got.MarshalArgs()
		if err != nil || got.Operation != c.tag || string(raw) != c.want {
			t.Errorf("%s as %s: %s %v, want %s", c.id, c.tag, raw, err, c.want)
		}
	}
}

// A template for an operation that takes one source (sync, bisync, mount or serve) can't have
// several. Blank sources don't count.
func TestOneSource(t *testing.T) {
	two := &Paths{Sources: []string{"src:x", "src:y"}, Destination: "dst:"}
	for _, tag := range []operations.Operation{"sync", "bisync", "mount", "serve"} {
		_, err := Check(&Template{Name: "x", Tags: []operations.Operation{"copy", tag}, Paths: two})
		label := strings.ToUpper(string(tag[:1])) + string(tag[1:])
		if want := "A " + label + " takes one source."; errs.FieldOf(err) != "paths" || !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%s with two sources: %v, want %q on paths", tag, err, want)
		}
		if _, err := Check(&Template{Name: "x", Tags: []operations.Operation{tag}, Paths: &Paths{Sources: []string{"src:x", " "}}}); err != nil {
			t.Errorf("%s with one source and a blank one: %v", tag, err)
		}
	}
	for _, tag := range []operations.Operation{"copy", "move", "delete", "purge"} {
		if _, err := Check(&Template{Name: "x", Tags: []operations.Operation{tag}, Paths: two}); err != nil {
			t.Errorf("%s with two sources: %v", tag, err)
		}
	}
}

func TestGroups(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	if _, err := s.Save(ctx, &Template{ID: "t", Name: "T", Tags: []operations.Operation{"copy", "mount"},
		Options: opts(`{"transfers": 4, "ignore_existing": true, "max_age": "1d", "vfs_cache_mode": "full"}`)}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		op            operations.Operation
		groups, skips string
	}{
		{"copy", `{"copy":{"ignore_existing":true},"filter":{"max_age":"1d"},"config":{"transfers":4}}`, `vfs_cache_mode`},
		{"purge", `{"config":{"ignore_existing":true,"transfers":4}}`, `max_age vfs_cache_mode`},
		{"mount", `{"filter":{"max_age":"1d"},"config":{"transfers":4},"vfs":{"vfs_cache_mode":"full"}}`, `ignore_existing`},
	} {
		got, err := s.Groups(ctx, "t", c.op, "")
		if err != nil {
			t.Fatal(c.op, err)
		}
		raw, _ := json.Marshal(got.Groups)
		var skips []string
		for _, f := range got.Skipped {
			skips = append(skips, f.Flag)
		}
		slices.Sort(skips)
		if string(raw) != c.groups || strings.Join(skips, " ") != c.skips {
			t.Errorf("%s: %s, skipped %v", c.op, raw, skips)
		}
	}
	if _, err := s.Groups(ctx, "missing", "copy", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("a missing template: %v", err)
	}
}

// The export holds each chosen template, in the list's order, with its options as a command line.
func TestExport(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "/opt/rcui")
	for _, tmpl := range []*Template{
		{ID: "a", Name: "A", Tags: []operations.Operation{"copy"}, Options: opts(`{"exclude": ["*.tmp", "a b"], "transfers": 4}`),
			Paths: &Paths{Sources: []string{"src:x"}, Destination: "dst:"}},
		{ID: "b", Name: "B <&>", Tags: []operations.Operation{"mount"}, Options: opts(`{"metadata": true, "metadata_mapper": ["metadata-map"]}`)},
		{ID: "c", Name: "C"},
	} {
		if _, err := s.Save(ctx, tmpl); err != nil {
			t.Fatal(err)
		}
	}
	text, err := s.Export(ctx, []string{"b", "a", "missing"}, "linux")
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0]["name"] != "A" || got[1]["name"] != "B <&>" || got[1]["paths"] != nil {
		t.Fatalf("exported %s", text)
	}
	if got[0]["command"] != `--exclude='*.tmp' --exclude='a b' --transfers=4` {
		t.Errorf("command %v", got[0]["command"])
	}
	if got[1]["command"] != `--metadata=true --metadata-mapper='/opt/rcui metadata-map'` {
		t.Errorf("command %v", got[1]["command"])
	}
	if !strings.Contains(text, `"B <&>"`) {
		t.Errorf("escaped: %s", text)
	}
}

// A page that asks about a template that doesn't exist gets not_found, not invalid.
func TestAPINotFound(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	_, err := s.RunArgs(ctx, "nope", "copy")
	if e := rclone.ErrorOf(err); e == nil || e.Code != errs.CodeNotFound || e.What != "template" {
		t.Errorf("RunArgs: %+v", e)
	}
	if e := rclone.ErrorOf(func() error { _, err := s.Get(ctx, "nope"); return err }()); e == nil || e.Code != errs.CodeNotFound {
		t.Errorf("Get: %+v", e)
	}
}
