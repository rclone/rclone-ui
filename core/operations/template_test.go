package operations

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// A template's flat options go into the groups of the operation's form, as its page shows them.
func TestTemplateGroups(t *testing.T) {
	const options = `{"transfers": 4, "max_age": "1d", "metadata_include": ["a=b"], "ignore_existing": true, ` +
		`"vfs_cache_mode": "full", "allow_other": true, "addr": ":8080", "no_such": 1}`
	group := func(g catalog.Group) string {
		if g == nil {
			return ""
		}
		raw, _ := json.Marshal(g)
		return string(raw)
	}
	skipped := func(s []catalog.SkippedFlag) []string {
		var out []string
		for _, f := range s {
			out = append(out, f.Flag)
		}
		slices.Sort(out)
		return out
	}
	for _, c := range []struct {
		op                                 Operation
		own, config, filter, metadata, vfs string
		skipped                            []string
	}{
		// A copy option lands in the copy group. vfs is left out for a copy, and so is an unknown
		// option.
		{"copy", `{"ignore_existing":true}`, `{"transfers":4}`, `{"max_age":"1d"}`, `{"metadata_include":["a=b"]}`, ``,
			[]string{"addr", "allow_other", "no_such", "vfs_cache_mode"}},
		// A purge reads only its config group, so its filters are left out, not refused.
		{"purge", ``, `{"ignore_existing":true,"transfers":4}`, ``, ``, ``,
			[]string{"addr", "allow_other", "max_age", "metadata_include", "no_such", "vfs_cache_mode"}},
		{"delete", ``, `{"ignore_existing":true,"transfers":4}`, `{"max_age":"1d"}`, `{"metadata_include":["a=b"]}`, ``,
			[]string{"addr", "allow_other", "no_such", "vfs_cache_mode"}},
		// A mount keeps its vfs option.
		{"mount", `{"allow_other":true}`, `{"transfers":4}`, `{"max_age":"1d"}`, `{"metadata_include":["a=b"]}`, `{"vfs_cache_mode":"full"}`,
			[]string{"addr", "ignore_existing", "no_such"}},
		{"serve", `{"addr":":8080"}`, `{"transfers":4}`, `{"max_age":"1d"}`, `{"metadata_include":["a=b"]}`, `{"vfs_cache_mode":"full"}`,
			[]string{"allow_other", "ignore_existing", "no_such"}},
	} {
		serve := ""
		if c.op == OperationServe {
			serve = "webdav"
		}
		g, s, err := TemplateGroups(c.op, serve, flat(options))
		if err != nil {
			t.Fatal(c.op, err)
		}
		own := ""
		switch c.op {
		case OperationCopy:
			own = group(g.Copy)
		case OperationMount:
			own = group(g.Mount)
		case OperationServe:
			own = group(g.Serve)
		}
		if own != c.own || group(g.Config) != c.config || group(g.Filter) != c.filter ||
			group(g.Metadata) != c.metadata || group(g.VFS) != c.vfs {
			t.Errorf("%s: own %s config %s filter %s metadata %s vfs %s", c.op, own, group(g.Config), group(g.Filter), group(g.Metadata), group(g.VFS))
		}
		if got := skipped(s); !slices.Equal(got, c.skipped) {
			t.Errorf("%s: skipped %v, want %v", c.op, got, c.skipped)
		}
	}
	// The numbers keep every digit.
	g, _, _ := TemplateGroups("copy", "", flat(`{"max_size": 12345678901234567890}`))
	if group(g.Filter) != `{"max_size":12345678901234567890}` {
		t.Errorf("a big number: %s", group(g.Filter))
	}
	if _, _, err := TemplateGroups("download", "", flat(`{}`)); err == nil {
		t.Error("a template for a download")
	}
}

// flat returns a template's options from their JSON.
func flat(raw string) catalog.Group {
	var g catalog.Group
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		panic(err)
	}
	return g
}

// FormSections names the catalog groups that each group of a form takes, as FormGroups fills them.
func TestFormSections(t *testing.T) {
	text := func(sections []FormSection) []string {
		var out []string
		for _, s := range sections {
			out = append(out, s.Group+"="+strings.Join(s.Catalog, ","))
		}
		return out
	}
	for _, tc := range []struct {
		op    Operation
		serve string
		want  []string
	}{
		{OperationCopy, "", []string{"copy=copy,sync", "filter=filter", "config=config", "metadata=metadata"}},
		{OperationPurge, "", []string{"config=config,copy,sync"}},
		{OperationServe, "http", []string{"serve=serve.http", "vfs=vfs", "config=config", "filter=filter", "metadata=metadata"}},
		{OperationDownload, "", nil},
	} {
		if got := text(FormSections(tc.op, tc.serve)); !slices.Equal(got, tc.want) {
			t.Errorf("%s: %q, want %q", tc.op, got, tc.want)
		}
	}
	if got := FormSections(OperationServe, ""); len(got[0].Catalog) != len(rclone.ServeTypes()) {
		t.Errorf("a serve of any type takes every type's group: %q", got[0].Catalog)
	}
}

// The form that runs a template builds the same settings as the page's form would.
func TestTemplateArgsBuild(t *testing.T) {
	f, err := TemplateArgs("copy", []string{"/a", "/b"}, "/c", flat(`{"transfers": 4, "max_age": "1d", "vfs_cache_mode": "full"}`))
	if err != nil || f.Copy == nil {
		t.Fatal(f, err)
	}
	s, err := settingsOf("copy", f.Copy.Options)
	if err != nil {
		t.Fatal(err)
	}
	if s.config["transfers"] != "4" || s.filter["max_age"] != "1d" {
		t.Errorf("settings %+v", s)
	}
	// A purge's filters are left out, so the start doesn't refuse them.
	f, err = TemplateArgs("purge", []string{"/a"}, "", flat(`{"max_age": "1d", "transfers": 4}`))
	if err != nil || f.Purge == nil {
		t.Fatal(f, err)
	}
	if s, err := settingsOf("purge", f.Purge.Options); err != nil || s.config["transfers"] != "4" || len(s.filter) != 0 {
		t.Errorf("a purge's filter: %+v %v", s, err)
	}
}

// A template's export writes its options with rclone's own flags, quoted for the shell.
func TestTemplateFlags(t *testing.T) {
	for _, c := range []struct {
		options, goos, want string
	}{
		{`{"vfs_cache_mode": "full", "transfers": 8, "fast_list": true}`, "linux",
			`--fast-list=true --transfers=8 --vfs-cache-mode=full`},
		// A repeated flag gets one flag per element. A blank value and an empty list are left out.
		{`{"exclude": ["*.tmp", "My Files/**"], "max_age": null, "include": [], "min_size": " "}`, "darwin",
			`--exclude='*.tmp' --exclude='My Files/**'`},
		{`{"backup_dir": "gdrive:it's old"}`, "linux", `--backup-dir='gdrive:it'\''s old'`},
		{`{"backup_dir": "gdrive:it's old"}`, "windows", `--backup-dir='gdrive:it''s old'`},
		// A name that rclone doesn't have is still written.
		{`{"no_such": "x"}`, "linux", `--no-such=x`},
	} {
		got, err := TemplateFlags(flat(c.options), "/opt/rcui", c.goos)
		if err != nil || got != c.want {
			t.Errorf("%s on %s: %q %v, want %q", c.options, c.goos, got, err, c.want)
		}
	}
	// The app's own metadata mapper runs this executable.
	got, err := TemplateFlags(flat(`{"metadata_mapper": ["metadata-map", "--map", "a=b"]}`), "/opt/Rclone UI/rcui", "linux")
	if want := `--metadata-mapper='"/opt/Rclone UI/rcui" metadata-map --map a=b'`; err != nil || got != want {
		t.Errorf("the mapper: %q %v, want %q", got, err, want)
	}
}

func TestTemplateArgsRefusals(t *testing.T) {
	for _, c := range []struct {
		tag     Operation
		sources []string
		want    string
	}{
		{"mount", []string{"/a"}, "A template does not run mount: apply it in its form."},
		{"serve", []string{"/a"}, "A template does not run serve: apply it in its form."},
		{"sync", []string{"/a", "/b"}, "The template needs one source to run."},
		{"bisync", []string{"/a", "/b"}, "The template needs one source to run."},
	} {
		_, err := TemplateArgs(c.tag, c.sources, "/c", flat(`{}`))
		if err == nil || !errs.Is(err) || err.Error() != c.want {
			t.Errorf("%s: %v, want %q", c.tag, err, c.want)
		}
	}
	// A missing source is left to the start, which says which path is missing.
	f, err := TemplateArgs("sync", nil, "/c", flat(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := f.MarshalArgs(); err != nil || string(raw) != `{"destination":"/c"}` {
		t.Errorf("sync without a source: %s %v", raw, err)
	}
	// Each tag runs as its own operation.
	for _, tag := range transferTags {
		if f, err := TemplateArgs(tag, []string{"/a"}, "/c", flat(`{}`)); err != nil || f.Operation != tag || f.Check() != nil {
			t.Errorf("%s: %+v %v", tag, f, err)
		}
	}
}
