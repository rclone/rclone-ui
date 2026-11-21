package operations

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/filter"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// settingsOf returns the settings that an operation's plan runs with.
func settingsOf(operation Operation, g Groups) (settings, error) {
	spec, ok := operationSpecs[operation]
	if !ok || spec.settings == nil {
		return settings{}, fmt.Errorf("no settings for the operation %q", operation)
	}
	return spec.settings(g)
}

func mustSettings(t *testing.T, operation Operation, g Groups) settings {
	t.Helper()
	s, err := settingsOf(operation, g)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// A page's option groups become rclone's main and filter options, with rclone's names and in
// rclone's text format. The config group overrides the operation's own group, the metadata group
// is split by rclone's blocks, and cleared fields are left out.
func TestTransferOptions(t *testing.T) {
	g := groups(
		"copy", `{"ignore_existing": true, "transfers": 2}`,
		"config", `{"transfers": 4, "no_traverse": true, "fast_list": true, "max_backlog": " ",
			"compare_dest": "gdrive:old", "name_transform": "file,suffix=_x", "checkers": "8"}`,
		"filter", `{"exclude": "*.{jpg,png}", "min_age": "off", "max_size": "", "files_from_raw": "x",
			"files_from0": ["list0"], "max_age": "1h"}`,
		"metadata", `{"metadata": true, "metadata_mapper": ["metadata-map", "--map", "mtime=modified"],
			"metadata_include": "key=value", "metadata_exclude_from": ["rules.txt"]}`,
	)
	s := mustSettings(t, "copy", g)
	wantConfig := Options{
		"ignore_existing": "true", "transfers": "4", "no_traverse": "true", "fast_list": "true",
		"compare_dest": []any{"gdrive:old"}, "name_transform": []any{"file,suffix=_x"}, "checkers": "8",
		"metadata": "true", "metadata_mapper": []any{"metadata-map", "--map", "mtime=modified"},
	}
	if !reflect.DeepEqual(s.config, wantConfig) {
		t.Errorf("config\n got %v\nwant %v", s.config, wantConfig)
	}
	wantFilter := Options{
		"exclude": []any{"*.{jpg,png}"}, "min_age": "off", "files_from_raw": []any{"x"},
		"files_from0": []any{"list0"}, "max_age": "1h",
		"metadata_include": []any{"key=value"}, "metadata_exclude_from": []any{"rules.txt"},
	}
	if !reflect.DeepEqual(s.filter, wantFilter) {
		t.Errorf("filter\n got %v\nwant %v", s.filter, wantFilter)
	}

	// Check the values that rclone gets.
	var ci fs.ConfigInfo
	if err := setOptions(blockMain, s.config, &ci); err != nil {
		t.Fatal(err)
	}
	if !ci.IgnoreExisting || ci.Transfers != 4 || !ci.NoTraverse || !ci.UseListR || ci.Checkers != 8 ||
		!reflect.DeepEqual(ci.CompareDest, []string{"gdrive:old"}) || !ci.Metadata ||
		!reflect.DeepEqual([]string(ci.MetadataMapper), []string{"metadata-map", "--map", "mtime=modified"}) {
		t.Errorf("config info %+v", ci)
	}
	var fo filter.Options
	if err := setOptions(blockFilter, s.filter, &fo); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fo.ExcludeRule, []string{"*.{jpg,png}"}) || fo.MinAge != fs.DurationOff ||
		fo.MaxAge != fs.Duration(time.Hour) || !reflect.DeepEqual(fo.FilesFrom0, []string{"list0"}) ||
		!reflect.DeepEqual(fo.MetaRules.IncludeRule, []string{"key=value"}) ||
		!reflect.DeepEqual(fo.MetaRules.ExcludeFrom, []string{"rules.txt"}) {
		t.Errorf("filter options %+v", fo)
	}
}

// Values written by a page are read the same way as that text after the flag on rclone's
// command line. A bare number means seconds for a duration and KiB for a size. An argv can be a
// list, or a line that rclone splits while keeping quoted parts together.
func TestOptionValues(t *testing.T) {
	for _, tc := range []struct {
		name, json string
		want       any
	}{
		{"a duration's bare number", `{"max_age": 300}`, fs.Duration(5 * time.Minute)},
		{"a duration's text", `{"max_age": "5m"}`, fs.Duration(5 * time.Minute)},
		{"rclone's off", `{"max_age": "off"}`, fs.DurationOff},
		{"a size's bare number", `{"max_size": 1000}`, fs.SizeSuffix(1000 << 10)},
		{"a size's text", `{"max_size": "10M"}`, fs.SizeSuffix(10 << 20)},
	} {
		o, err := decodeOptions(json.RawMessage(tc.json))
		if err != nil {
			t.Fatal(err)
		}
		stored, err := storedOptions(blockFilter, o)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		var fo filter.Options
		if err := setOptions(blockFilter, stored, &fo); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := any(fo.MaxAge)
		if _, isSize := tc.want.(fs.SizeSuffix); isSize {
			got = fo.MaxSize
		}
		if got != tc.want {
			t.Errorf("%s: %v (stored %v), want %v", tc.name, got, stored, tc.want)
		}
	}
	o, _ := decodeOptions(json.RawMessage(`{"metadata_mapper": "\"/opt/my mapper\" --flag 'a b'", "password_command": "pass show x"}`))
	stored, err := storedOptions(blockMain, o)
	if err != nil {
		t.Fatal(err)
	}
	// rclone's own split (fs.SpaceSepList) keeps a double-quoted field together and treats
	// single quotes as text.
	if got := anyTexts(stored["metadata_mapper"]); !reflect.DeepEqual(got, []string{"/opt/my mapper", "--flag", "'a", "b'"}) {
		t.Errorf("a typed mapper line: %q", got)
	}
	if got := anyTexts(stored["password_command"]); !reflect.DeepEqual(got, []string{"pass", "show", "x"}) {
		t.Errorf("a typed command line: %q", got)
	}
}

// Values that rclone would refuse are refused by name before anything runs. A cleared field
// counts as no value.
func TestOptionRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, group, json, want string
	}{
		{"an unknown option", "config", `{"transfer": 4}`, "transfer is not one of the options rclone takes here."},
		{"an unknown filter", "filter", `{"files_fromx": ["a"]}`, "files_fromx is not one of the options rclone takes here."},
		{"a filter in the config", "config", `{"include": "*.jpg"}`, "include is not one of the options rclone takes here."},
		{"not rclone's option, though rclone's struct has it", "config", `{"disable": "copy"}`, "disable is not one of the options rclone takes here."},
		{"a flag's spelling", "config", `{"--dry-run": true}`, "--dry-run is written dry_run here."},
		{"a dashed spelling", "filter", `{"max-age": "1h"}`, "max-age is written max_age here."},
		{"a dashed spelling of an unknown option", "config", `{"dry-runs": true}`, "dry-runs is not one of the options rclone takes here."},
		{"two spellings", "config", `{"dry-run": true, "dry_run": false}`, "dry-run is written dry_run here."},
		{"an option rclone sets once", "config", `{"bwlimit": "1M"}`,
			"bwlimit can't be set for one transfer, because rclone sets it once: for the whole app, or when it first opens a remote."},
		{"an option read when a remote opens", "metadata", `{"timeout": "1m"}`, "timeout can't be set for one transfer"},
		{"a bad duration", "filter", `{"max_age": "soon"}`, "max_age"},
		{"a bad number", "config", `{"transfers": "many"}`, "transfers"},
		{"a list for one value", "config", `{"transfers": [1, 2]}`, "transfers: takes one value"},
	} {
		_, err := settingsOf("copy", groups(tc.group, tc.json))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	s, err := settingsOf("copy", groups("config", `{"transfers": "", "checkers": null, "": ""}`, "filter", `{"include": " "}`))
	if err != nil || s.config != nil || s.filter != nil {
		t.Errorf("cleared fields: %+v %v", s, err)
	}
}

// No transfer can set an option that rclone sets once for the whole app, or when it first opens a
// remote, because it would do nothing. A mount or a serve runs as its own process, where it
// takes effect.
func TestNotPerOperation(t *testing.T) {
	for _, name := range rclone.NotPerOperation {
		want := name + " can't be set for one transfer"
		for _, op := range []Operation{"copy", "move", "sync", "bisync", "delete", "purge", "download", OperationSave} {
			_, err := settingsOf(op, groups("config", fmt.Sprintf(`{%q: "1"}`, name)))
			if err == nil || !errs.Is(err) || !strings.Contains(err.Error(), want) {
				t.Errorf("%s with %s: %v", op, name, err)
			}
		}
		if err := CheckOption("sync", name); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("CheckOption(sync, %s): %v", name, err)
		}
		if err := CheckOption("mount", name); err != nil {
			t.Errorf("CheckOption(mount, %s): %v", name, err)
		}
	}
	if _, err := MountCommand(MountArgs{Source: "gdrive:", Destination: "/m",
		Options: groups("config", `{"timeout": "1m", "contimeout": "10s"}`)}, MountEnv{OS: "linux"}); err != nil {
		t.Errorf("a mount with timeout: %v", err)
	}
}

// A template's options are checked for each transfer it is for.
func TestCheckOption(t *testing.T) {
	for _, tc := range []struct {
		tag       Operation
		key, want string
	}{
		{"copy", "transfers", ""},
		{"delete", "max_age", ""},
		{"bisync", "metadata_mapper", ""},
		{"copy", "--transfers", "--transfers is written transfers here."},
		{"purge", "no_such_option", "no_such_option is not one of the options rclone takes here."},
		{"move", "vfs_cache_mode", "vfs_cache_mode is not one of the options rclone takes here."},
		{"mount", "no_such_option", ""},
		{"serve", "--bwlimit", ""},
	} {
		got := ""
		if err := CheckOption(tc.tag, tc.key); err != nil {
			got = err.Error()
		}
		if got != tc.want {
			t.Errorf("%s %s: %q, want %q", tc.tag, tc.key, got, tc.want)
		}
	}
	for _, tc := range []struct {
		tags    []Operation
		options string
		want    string
	}{
		{[]Operation{"copy"}, `{"transfers": 4, "no_such": 1}`, ""},
		{[]Operation{"mount", "serve"}, `{"bwlimit": "1M"}`, ""},
		{[]Operation{"mount", "copy"}, `{"bwlimit": "1M"}`, "bwlimit can't be set for one transfer"},
		{[]Operation{"purge"}, `{"--user-agent": "me"}`, "user_agent can't be set for one transfer"},
	} {
		err := CheckTemplate(tc.tags, flat(tc.options))
		if (err == nil) != (tc.want == "") || err != nil && !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v %s: %v, want %q", tc.tags, tc.options, err, tc.want)
		}
	}
}

// A remote's overrides go in its connection string through rclone's own writer, merged over
// the parameters that the path already had. Nothing in a key or a value can set another option.
func TestConnectionStrings(t *testing.T) {
	remotes := remoteOverrides{
		"gdrive": {"chunk_size": "64M", "shared_with_me": true, "list_chunk": json.Number("500"), "blank": " "},
		":local": {"copy_links": true},
		"sftp":   {"pass": `x',ssh='sh`},
	}
	fsOf := func(p string, remotes remoteOverrides) (string, error) {
		at := split(p)
		return fsString(at, at.Path(), remotes[at.Name])
	}
	for _, tc := range []struct{ in, want string }{
		{"gdrive:photos/", `gdrive,chunk_size='64M',list_chunk='500',shared_with_me='true':photos/`},
		{`gdrive,chunk_size="8M",acknowledge_abuse:a/b.txt`, `gdrive,acknowledge_abuse='true',chunk_size='64M',list_chunk='500',shared_with_me='true':a/b.txt`},
		{"/tmp/x/", `:local,copy_links='true':/tmp/x/`},
		{"sftp:/srv", `sftp,pass='x'',ssh=''sh':/srv`},
		{"other:x", "other:x"},
		{`:sftp,host="a:b":/srv`, `:sftp,host="a:b":/srv`},
	} {
		got, err := fsOf(tc.in, remotes)
		if err != nil || got != tc.want {
			t.Errorf("%s: %q %v, want %q", tc.in, got, err, tc.want)
		}
	}
	if _, err := fsOf("gdrive:", remoteOverrides{"gdrive": {`a="x",ssh`: "y"}}); err == nil ||
		!strings.Contains(err.Error(), "cannot be an option of gdrive") {
		t.Errorf("a key that would write another option: %v", err)
	}
}

// A remote's overrides are checked against its backend before the Fs is opened. rclone would
// ignore a key that it doesn't know, and it would only parse a value when the Fs opens.
func TestOverridesChecked(t *testing.T) {
	copyTo := func(destination, remotes string) error {
		s, err := settingsOf("copy", groups("remotes", remotes))
		if err != nil {
			return err
		}
		_, err = buildCopy(CopyArgs{Sources: []string{"/tmp/a.txt"}, Destination: destination}, s, nil)
		return err
	}
	for _, tc := range []struct{ destination, remotes, want string }{
		{"gdrive:in", `{"gdrive": {"chunk_size": "64M", "shared_with_me": true, "list_chunk": 500}}`, ""},
		{"/tmp/in", `{":local": {"copy_links": true, "override.timeout": "30s"}}`, ""},
		{"sftp:/in", `{"sftp": {"host": "h", "port": "2222"}}`, ""},
		// A cleared field is not an override, whatever its key.
		{"gdrive:in", `{"gdrive": {"chunk_sise": " "}}`, ""},
		// Overrides for another remote are not checked here.
		{"gdrive:in", `{"gone": {"x": "1"}}`, ""},
		{"gdrive:in", `{"gdrive": {"chunk_sise": "64M"}}`, "‘chunk_sise’ is not an option of gdrive (a drive remote)"},
		{"gdrive:in", `{"gdrive": {"type": "s3"}}`, "‘type’ is not an option of gdrive (a drive remote)"},
		{"gdrive:in", `{"gdrive": {"chunk_size": "lots"}}`, `chunk_size of gdrive: parsing "lots" as fs.SizeSuffix failed`},
		{"sftp:/in", `{"sftp": {"port": "twenty-two"}}`, `port of sftp: parsing "twenty-two" as int failed`},
		{"/tmp/in", `{":local": {"override.timeout": "soon"}}`, `override.timeout of :local: parsing "soon" as time.Duration failed`},
		{"/tmp/in", `{":local": {"override.no_such_option": "1"}}`, "‘override.no_such_option’ is not an option of :local (a local remote)"},
		{"/tmp/in", `{":local": {"global.timeout": "30s"}}`, "‘global.timeout’ would change rclone’s options for everything the app runs; override.timeout changes them for :local alone"},
		{"gone:in", `{"gone": {"x": "1"}}`, "didn't find section in config file"},
	} {
		err := copyTo(tc.destination, tc.remotes)
		switch {
		case tc.want == "" && err != nil:
			t.Errorf("%s %s: %v", tc.destination, tc.remotes, err)
		case tc.want != "" && (err == nil || !strings.HasPrefix(err.Error(), tc.want)):
			t.Errorf("%s %s: %v, want %q", tc.destination, tc.remotes, err, tc.want)
		}
	}
}

// A file that is inside a folder source is copied only once, with the folder, however either
// path is written. A name that only starts with the folder's name is not inside it.
func TestFilesInsideFolderSources(t *testing.T) {
	copyOf := func(sources []string, k Kinds) []Step {
		t.Helper()
		p, err := buildCopy(CopyArgs{Sources: sources, Destination: "mem:in"}, settings{}, k)
		if err != nil {
			t.Fatal(err)
		}
		return p.Steps
	}
	for _, tc := range []struct {
		name    string
		sources []string
		k       Kinds
		steps   int
	}{
		{"a remote's root holds its files", []string{"gdrive:", "gdrive:file.txt"}, Kinds{"gdrive:": KindFolder, "gdrive:file.txt": KindFile}, 1},
		{"a local folder holds :local:'s spelling", []string{"/tmp", ":local:/tmp/x"}, Kinds{"/tmp": KindFolder, ":local:/tmp/x": KindFile}, 1},
		{"a trailing slash is spelling", []string{"gdrive:a/", "gdrive:a/b/c.txt"}, Kinds{"gdrive:a/": KindFolder, "gdrive:a/b/c.txt": KindFile}, 1},
		{"a name that starts like the folder's", []string{"gdrive:a", "gdrive:ab.txt"}, Kinds{"gdrive:a": KindFolder, "gdrive:ab.txt": KindFile}, 2},
		{"another root of the same remote", []string{"sftp:a", "sftp:/a/x.txt"}, Kinds{"sftp:a": KindFolder, "sftp:/a/x.txt": KindFile}, 2},
		{"another remote", []string{"gdrive:a", "mem:a/x.txt"}, Kinds{"gdrive:a": KindFolder, "mem:a/x.txt": KindFile}, 2},
	} {
		if steps := copyOf(tc.sources, tc.k); len(steps) != tc.steps {
			t.Errorf("%s: %+v", tc.name, steps)
		}
	}
	p, err := buildDelete(DeleteArgs{Sources: []string{"gdrive:a", "gdrive:a/file.txt"}}, settings{},
		Kinds{"gdrive:a": KindFolder, "gdrive:a/file.txt": KindFile})
	if err != nil || len(p.Steps) != 1 || p.Steps[0].Op != OpDelete {
		t.Errorf("delete %+v %v", p, err)
	}
}

// A delete or a purge removes a folder and its contents in one step, however the paths are
// written. A second step for a subfolder, or for another spelling of the folder, would run
// alongside the first and fail on what the first removed. A folder whose name only starts with
// another folder's name gets its own step.
func TestNestedDeleteAndPurgeSources(t *testing.T) {
	folders := Kinds{}
	for _, f := range []string{"gdrive:a", "gdrive:a/", "gdrive:a/b", "gdrive:ab", "/tmp/x", ":local:/tmp/x/y", "sftp:a", "sftp:/a/b"} {
		folders[f] = KindFolder
	}
	for _, tc := range []struct {
		name    string
		sources []string
		deletes []string // each step's Src
		purges  []string // each step's SrcRemote
	}{
		{"a folder and its subfolder", []string{"gdrive:a", "gdrive:a/b"}, []string{"gdrive:a"}, []string{"a"}},
		{"the subfolder first", []string{"gdrive:a/b", "gdrive:a"}, []string{"gdrive:a"}, []string{"a"}},
		{"a folder spelled twice", []string{"gdrive:a", "gdrive:a/"}, []string{"gdrive:a"}, []string{"a"}},
		{"a local folder and :local:'s spelling inside it", []string{"/tmp/x", ":local:/tmp/x/y"}, []string{":local:/tmp/x"}, []string{"tmp/x"}},
		{"a name that starts like the folder's", []string{"gdrive:a", "gdrive:ab"}, []string{"gdrive:a", "gdrive:ab"}, []string{"a", "ab"}},
		{"another root of the same remote", []string{"sftp:a", "sftp:/a/b"}, []string{"sftp:a", "sftp:/a/b"}, []string{"a", "a/b"}},
	} {
		d, err := buildDelete(DeleteArgs{Sources: tc.sources}, settings{}, folders)
		var got []string
		for _, s := range d.Steps {
			got = append(got, s.Src)
		}
		if err != nil || !slices.Equal(got, tc.deletes) {
			t.Errorf("delete, %s: %v %v, want %v", tc.name, got, err, tc.deletes)
		}
		p, err := buildPurge(PurgeArgs{Sources: tc.sources}, settings{}, folders)
		got = nil
		for _, s := range p.Steps {
			got = append(got, s.SrcRemote)
		}
		if err != nil || !slices.Equal(got, tc.purges) {
			t.Errorf("purge, %s: %v %v, want %v", tc.name, got, err, tc.purges)
		}
	}
	// A file inside a purged folder is still refused: only folders are purged.
	_, err := buildPurge(PurgeArgs{Sources: []string{"gdrive:a", "gdrive:a/f.txt"}}, settings{},
		Kinds{"gdrive:a": KindFolder, "gdrive:a/f.txt": KindFile})
	if want := "gdrive:a/f.txt is a file; only folders can be purged"; err == nil || err.Error() != want {
		t.Errorf("purge of a file inside a folder: %v, want %q", err, want)
	}
}

// chunks returns the settings of a copy with an override for gdrive.
func chunks(t *testing.T) settings {
	return mustSettings(t, "copy", groups("remotes", `{"gdrive": {"chunk_size": "64M"}}`))
}

// Two sources that would write the same entry in the destination are refused, even when their
// names differ in case or in Unicode form. A root combined with other sources is refused too,
// because its entries go straight into the destination. A source inside a folder source, and a
// second spelling of the same source, are transferred with it.
func TestSameNameSources(t *testing.T) {
	const (
		composed   = "/a/été.txt"   // é as one code point (NFC)
		decomposed = "/b/été.txt" // e and a combining accent (NFD)
	)
	folders := Kinds{
		"/2023/photos": KindFolder, "/2024/photos": KindFolder, "/2023": KindFolder, "sftp:": KindFolder,
		"sftp:/": KindFolder, "gdrive:": KindFolder, "gdrive:a": KindFolder, "gdrive:a/": KindFolder, "/": KindFolder,
	}
	for _, tc := range []struct {
		name    string
		sources []string
		steps   int // 0 means refused
	}{
		{"two files of one name", []string{"/a/r.txt", "/b/r.txt"}, 0},
		{"names that differ in case", []string{"/a/r.txt", "/c/R.TXT"}, 0},
		{"one name in two Unicode forms", []string{composed, decomposed}, 0},
		{"two folders of one name", []string{"/2023/photos", "/2024/photos"}, 0},
		{"two roots", []string{"sftp:", "sftp:/"}, 0},
		{"a root and another remote's file", []string{"gdrive:", "mem:x.txt"}, 0},
		{"a folder and its subfolder", []string{"/2023", "/2023/photos"}, 1},
		{"a folder spelled twice", []string{"gdrive:a", "gdrive:a/"}, 1},
		{"a root and a file in it", []string{"/", "/etc/hosts"}, 1},
		{"a file and a folder", []string{"/a/r.txt", "/2024/photos"}, 2},
	} {
		for op, build := range map[string]func(CopyArgs) (Plan, error){
			"copy": func(a CopyArgs) (Plan, error) { return buildCopy(a, settings{}, folders) },
			"move": func(a CopyArgs) (Plan, error) { return buildMove(MoveArgs(a), settings{}, folders) },
		} {
			p, err := build(CopyArgs{Sources: tc.sources, Destination: "/x"})
			switch {
			case tc.steps == 0 && (err == nil || !errs.Is(err)):
				t.Errorf("%s, %s: %+v %v, want a refusal", op, tc.name, p.Steps, err)
			case tc.steps > 0 && (err != nil || len(p.Steps) != tc.steps):
				t.Errorf("%s, %s: %+v %v, want %d steps", op, tc.name, p.Steps, err, tc.steps)
			}
		}
	}
	_, err := buildMove(MoveArgs{Sources: []string{"/a/r.txt", "/c/R.TXT"}, Destination: "/x"}, settings{}, nil)
	if want := "/a/r.txt and /c/R.TXT would both go to " + filepath.FromSlash("/x/R.TXT") +
		". Their names differ only in case, which a provider that ignores case treats as one name. Move them separately."; err == nil || err.Error() != want {
		t.Errorf("the refusal says %v, want %q", err, want)
	}
	_, err = buildCopy(CopyArgs{Sources: []string{"/a/r.txt", "/b/r.txt"}, Destination: "/x"}, settings{}, nil)
	if want := "/a/r.txt and /b/r.txt would both go to " + filepath.FromSlash("/x/r.txt") +
		". Copy them separately."; err == nil || err.Error() != want {
		t.Errorf("the refusal says %v, want %q", err, want)
	}
	// One name in two Unicode forms is the same name, not one that differs in case.
	_, err = buildCopy(CopyArgs{Sources: []string{composed, decomposed}, Destination: "/x"}, settings{}, nil)
	if err == nil || strings.Contains(err.Error(), "differ only in case") {
		t.Errorf("the refusal says %v", err)
	}
	_, err = buildCopy(CopyArgs{Sources: []string{"gdrive:", "mem:x.txt"}, Destination: "/x"}, settings{}, folders)
	if want := "gdrive: is a root: everything in it goes straight into /x, so it can’t be combined with other sources."; err == nil || err.Error() != want {
		t.Errorf("the refusal says %v, want %q", err, want)
	}
}

func buildOf(t *testing.T, build func() (Plan, error)) Plan {
	t.Helper()
	p, err := build()
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err != nil {
		t.Fatalf("%+v: %v", p, err)
	}
	return p
}

// A step's source is its file's full path, or its folder. A Windows share keeps both of its
// slashes after the backend's name, where a single slash would name a folder on the current drive.
func TestStepSource(t *testing.T) {
	for _, tc := range []struct {
		step Step
		want string
	}{
		{Step{Src: "gdrive:a", SrcRemote: "b/c.txt"}, "gdrive:a/b/c.txt"},
		{Step{Src: ":local:/tmp/x/"}, ":local:/tmp/x/"},
		{Step{Src: ":local:/", SrcRemote: "tmp/x.txt"}, ":local:/tmp/x.txt"},
		{Step{Src: ":local://srv/share/", SrcRemote: "b.txt"}, ":local://srv/share/b.txt"},
		{Step{Src: ":local://srv/share/"}, ":local://srv/share/"},
		{Step{Dst: "gdrive:dl", DstRemote: "f.zip"}, "gdrive:dl/f.zip"},
	} {
		if got := tc.step.Source(); got != tc.want {
			t.Errorf("%+v: %q, want %q", tc.step, got, tc.want)
		}
	}
}

// The steps that each page's form is built into.
func TestBuilders(t *testing.T) {
	none := settings{}
	folders := Kinds{"gdrive:folder": KindFolder, "gdrive:folder/inner.txt": KindFile, "/tmp/photos": KindFolder}
	for _, tc := range []struct {
		name  string
		build func() (Plan, error)
		want  []Step
	}{
		{"a folder and a file in it", func() (Plan, error) {
			return buildCopy(CopyArgs{Sources: []string{"gdrive:folder", "gdrive:folder/inner.txt", "gdrive:folder"}, Destination: "e2e-memory:in"}, none, folders)
		}, []Step{{Op: OpCopy, Src: "gdrive:folder/", Dst: "e2e-memory:in/folder", CreateEmptySrcDirs: true}}},
		{"a folder's slash kept", func() (Plan, error) {
			return buildCopy(CopyArgs{Sources: []string{"sftp:/var/www/"}, Destination: "gdrive:in"}, chunks(t), nil)
		}, []Step{{Op: OpCopy, Src: "sftp:/var/www/", Dst: "gdrive,chunk_size='64M':in/www", CreateEmptySrcDirs: true}}},
		{"a root into the destination", func() (Plan, error) {
			return buildCopy(CopyArgs{Sources: []string{"sftp:"}, Destination: "gdrive:in"}, chunks(t), nil)
		}, []Step{{Op: OpCopy, Src: "sftp:", Dst: "gdrive,chunk_size='64M':in/", CreateEmptySrcDirs: true}}},
		{"a root's slash kept", func() (Plan, error) {
			return buildCopy(CopyArgs{Sources: []string{"sftp:/"}, Destination: "gdrive:in"}, chunks(t), nil)
		}, []Step{{Op: OpCopy, Src: "sftp:/", Dst: "gdrive,chunk_size='64M':in/", CreateEmptySrcDirs: true}}},
		{"files moved", func() (Plan, error) {
			return buildMove(MoveArgs{Sources: []string{"gdrive:a/one.txt", "/tmp/two.txt"}, Destination: "/dst/"}, none, nil)
		}, []Step{
			{Op: OpMoveFile, Src: "gdrive:", SrcRemote: "a/one.txt", Dst: ":local:/", DstRemote: "dst/one.txt"},
			{Op: OpMoveFile, Src: ":local:/", SrcRemote: "tmp/two.txt", Dst: ":local:/", DstRemote: "dst/two.txt"},
		}},
		{"a sync", func() (Plan, error) {
			return buildSync(SyncArgs{Source: "/tmp/photos", Destination: "gdrive:backup"}, none, folders)
		}, []Step{{Op: OpSync, Src: ":local:/tmp/photos/", Dst: "gdrive:backup/", CreateEmptySrcDirs: true}}},
		{"a delete of a folder and a file", func() (Plan, error) {
			return buildDelete(DeleteArgs{Sources: []string{"gdrive:folder", "gdrive:folder/inner.txt", "gdrive:x.txt"}}, none, folders)
		}, []Step{{Op: OpDelete, Src: "gdrive:folder"}, {Op: OpDeleteFile, Src: "gdrive:", SrcRemote: "x.txt"}}},
		{"a purge", func() (Plan, error) {
			return buildPurge(PurgeArgs{Sources: []string{"gdrive:folder", "/tmp/photos"}}, none, folders)
		}, []Step{{Op: OpPurge, Src: "gdrive:", SrcRemote: "folder"}, {Op: OpPurge, Src: ":local:/", SrcRemote: "tmp/photos"}}},
		{"a download", func() (Plan, error) {
			return buildDownload(DownloadArgs{URL: "https://e/x.zip", Filename: "x.zip", Destination: "/tmp/dl"}, none)
		}, []Step{{Op: OpCopyURL, Dst: ":local:/tmp/dl", DstRemote: "x.zip", URL: "https://e/x.zip"}}},
		{"a folder saved", func() (Plan, error) {
			return buildSave(SaveArgs{Source: "gdrive:folder", Destination: "/srv/saved"}, none, folders)
		}, []Step{{Op: OpCopy, Src: "gdrive:folder/", Dst: ":local:/srv/saved", CreateEmptySrcDirs: true}}},
		{"a file saved", func() (Plan, error) {
			return buildSave(SaveArgs{Source: "gdrive:folder/inner.txt", Destination: "/srv/f.txt"}, none, folders)
		}, []Step{{Op: OpCopyFile, Src: "gdrive:", SrcRemote: "folder/inner.txt", Dst: ":local:/", DstRemote: "srv/f.txt"}}},
		{"a batch rename", func() (Plan, error) {
			return buildRename([]RenameItem{{Path: "gdrive:a/old.txt", NewName: "new.txt"}, {Path: "gdrive:/a/dir", IsDir: true, NewName: "d2"}})
		}, []Step{
			{Op: OpMoveFile, Src: "gdrive:", SrcRemote: "a/old.txt", Dst: "gdrive:", DstRemote: "a/new.txt", Rename: true},
			{Op: OpMove, Src: "gdrive:/a/dir/", Dst: "gdrive:/a/d2/", CreateEmptySrcDirs: true, DeleteEmptySrcDirs: true, Rename: true},
		}},
		{"a folder deleted", func() (Plan, error) { return buildFolderDelete("gdrive:a/b") },
			[]Step{{Op: OpPurge, Src: "gdrive:", SrcRemote: "a/b"}}},
		{"a cleanup", func() (Plan, error) { return buildCleanup("gdrive:") }, []Step{{Op: OpCleanup, Src: "gdrive:"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if p := buildOf(t, tc.build); !reflect.DeepEqual(p.Steps, tc.want) {
				t.Errorf("steps\n got %+v\nwant %+v", p.Steps, tc.want)
			}
		})
	}
	// A rename runs one step at a time, because the batch rename's collision checks assume it.
	// None of its steps replaces an entry that appeared after the checks.
	if p := buildOf(t, func() (Plan, error) { return buildRename([]RenameItem{{Path: "gdrive:a", NewName: "b"}}) }); p.Concurrency != 1 ||
		!reflect.DeepEqual(p.Config, Options{"ignore_existing": "true"}) {
		t.Errorf("rename concurrency %d, config %v", p.Concurrency, p.Config)
	}
	// A bisync's switches that are on are the parameters of sync/bisync.
	p := buildOf(t, func() (Plan, error) {
		s := mustSettings(t, "bisync", groups("bisync", `{"max_delete": 10}`, "filter", `{"exclude": ["*.tmp"]}`))
		return buildBisync(BisyncArgs{Source: "/tmp/photos", Destination: "gdrive:b",
			Options: groups("outer", `{"resync": true, "force": false, "compare": "size,modtime"}`)}, s, folders)
	})
	// Without its own maxDelete, a bisync gets bisync's default of 50%, which sync/bisync over rc
	// doesn't apply itself.
	if !reflect.DeepEqual(p.Bisync, map[string]any{"resync": true, "compare": "size,modtime", "maxDelete": 50}) ||
		p.Config["max_delete"] != "10" || p.Filter == nil || p.Steps[0].Op != OpBisync || !p.Whole() {
		t.Errorf("bisync %+v", p)
	}
	// A maxDelete of the page's own is kept.
	p = buildOf(t, func() (Plan, error) {
		return buildBisync(BisyncArgs{Source: "/tmp/photos", Destination: "gdrive:b",
			Options: groups("outer", `{"maxDelete": 80}`)}, settings{}, folders)
	})
	if fmt.Sprint(p.Bisync["maxDelete"]) != "80" {
		t.Errorf("maxDelete %v", p.Bisync["maxDelete"])
	}
}

// checkThenBuild runs an operation's check hook and then its builder, as BuildPlan does after it
// asks rclone about the sources.
func checkThenBuild[A any, P argsOf[A]](op Operation, a A, s settings, k Kinds) (Plan, error) {
	spec := operationSpecs[op]
	if err := spec.check(P(&a), s); err != nil {
		return Plan{}, err
	}
	return spec.build(P(&a), s, k)
}

func TestBuilderRefusals(t *testing.T) {
	fileKinds := Kinds{"gdrive:file.txt": KindFile, "gdrive:a.txt": KindFile}
	filter := func(json string) settings { return mustSettings(t, "copy", groups("filter", json)) }
	for _, tc := range []struct {
		name  string
		build func() (Plan, error)
		want  string
	}{
		{"purge of a file by its spelling", func() (Plan, error) {
			return checkThenBuild(OperationPurge, PurgeArgs{Sources: []string{"/tmp/one.txt"}}, settings{}, nil)
		}, "/tmp/one.txt is a file; only folders can be purged"},
		{"purge of a file by rclone's answer", func() (Plan, error) {
			return checkThenBuild(OperationPurge, PurgeArgs{Sources: []string{"gdrive:file.txt"}}, settings{}, fileKinds)
		}, "gdrive:file.txt is a file; only folders can be purged"},
		{"purge of a remote's root", func() (Plan, error) {
			return checkThenBuild(OperationPurge, PurgeArgs{Sources: []string{"gdrive:folder", "gdrive:"}}, settings{},
				Kinds{"gdrive:folder": KindFolder, "gdrive:": KindFolder})
		}, "gdrive: is the root of a remote. Choose the folders inside it."},
		{"purge of a disk's root", func() (Plan, error) {
			return checkThenBuild(OperationPurge, PurgeArgs{Sources: []string{"/"}}, settings{}, Kinds{"/": KindFolder})
		}, "/ is the root of a remote. Choose the folders inside it."},
		{"purge of a remote's absolute root", func() (Plan, error) {
			return checkThenBuild(OperationPurge, PurgeArgs{Sources: []string{"sftp:/"}}, settings{}, Kinds{"sftp:/": KindFolder})
		}, "sftp:/ is the root of a remote. Choose the folders inside it."},
		{"delete of a remote's root", func() (Plan, error) {
			return checkThenBuild(OperationDelete, DeleteArgs{Sources: []string{"gdrive:folder", "gdrive:"}}, settings{},
				Kinds{"gdrive:folder": KindFolder, "gdrive:": KindFolder})
		}, "gdrive: is the root of a remote. Choose the folders inside it."},
		{"delete of a disk's root", func() (Plan, error) {
			return checkThenBuild(OperationDelete, DeleteArgs{Sources: []string{"/"}}, settings{}, Kinds{"/": KindFolder})
		}, "/ is the root of a remote. Choose the folders inside it."},
		{"sync of a file", func() (Plan, error) {
			return checkThenBuild(OperationSync, SyncArgs{Source: "gdrive:file.txt", Destination: "e2e-memory:in"}, settings{}, fileKinds)
		}, "gdrive:file.txt is a file; a sync needs a folder"},
		{"bisync of a file", func() (Plan, error) {
			return checkThenBuild(OperationBisync, BisyncArgs{Source: "gdrive:a.txt", Destination: "e2e-memory:b"}, settings{}, fileKinds)
		}, "gdrive:a.txt is a file; a bisync needs two folders"},
		{"roots with other sources", func() (Plan, error) {
			return checkThenBuild(OperationCopy, CopyArgs{Sources: []string{"sftp:/var/www/", "sftp:", "sftp:/"}, Destination: "gdrive:in"}, chunks(t), nil)
		}, "sftp: is a root: everything in it goes straight into gdrive:in, so it can’t be combined with other sources."},
		{"include rules with two sources", func() (Plan, error) {
			return checkThenBuild(OperationCopy, CopyArgs{Sources: []string{"/a/", "/b/"}, Destination: "/c"}, filter(`{"include": ["*.jpg"]}`), nil)
		}, "Include rules are not supported with multiple sources"},
		{"a filter with a file source", func() (Plan, error) {
			s := mustSettings(t, "copy", groups("metadata", `{"metadata_include": "k=v"}`))
			return checkThenBuild(OperationCopy, CopyArgs{Sources: []string{"/a/x.txt"}, Destination: "/c"}, s, nil)
		}, "Filters are only supported when every selected source is a folder"},
		{"a cleared filter is no filter", func() (Plan, error) {
			_, err := checkThenBuild(OperationCopy, CopyArgs{Sources: []string{"/a/x.txt"}, Destination: "/c"}, filter(`{"max_size": "  "}`), nil)
			return Plan{}, err
		}, ""},
		{"a path rclone refuses", func() (Plan, error) {
			return checkThenBuild(OperationCopy, CopyArgs{Sources: []string{"-bad:x"}, Destination: "/c"}, settings{}, nil)
		}, "Rclone cannot read this path: config name contains invalid characters"},
		{"a batch rename to nothing", func() (Plan, error) {
			return checkThenBuild(OperationRename, RenameArgs{Items: []RenameItem{{Path: "gdrive:a.txt", NewName: " "}}}, settings{}, nil)
		}, "Name cannot be empty"},
		{"a download named as a path", func() (Plan, error) {
			return checkThenBuild(OperationDownload, DownloadArgs{URL: "https://e/x", Filename: "mp3/../x", Destination: "/tmp/dl"}, settings{}, nil)
		}, "A name cannot contain / or \\"},
		{"a download named above its folder", func() (Plan, error) {
			return checkThenBuild(OperationDownload, DownloadArgs{URL: "https://e/x", Filename: "..", Destination: "/tmp/dl"}, settings{}, nil)
		}, "A name cannot contain / or \\"},
		{"a download named with a backslash", func() (Plan, error) {
			return checkThenBuild(OperationDownload, DownloadArgs{URL: "https://e/x", Filename: `a\b.zip`, Destination: "/tmp/dl"}, settings{}, nil)
		}, "A name cannot contain / or \\"},
		{"a remote's root is not deleted as a folder", func() (Plan, error) {
			return checkThenBuild(OperationDeleteFolder, FolderArgs{Path: "gdrive:"}, settings{}, nil)
		}, "A remote’s root cannot be deleted here"},
		{"a cleanup of nothing", func() (Plan, error) {
			return checkThenBuild(OperationCleanup, CleanupArgs{Remote: " "}, settings{}, nil)
		}, "Please choose a remote to clean up"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.build()
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("unexpected error %v", err)
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("error %v, want %q", err, tc.want)
			case tc.want != "" && !errs.Is(err):
				t.Fatalf("%v is not said as the user's to fix", err)
			}
		})
	}
}

// The path of a downloaded file, as its record shows it, is in the destination folder, and its
// root is written the same way as the folder's.
func TestDownloadTarget(t *testing.T) {
	targets := map[string]string{
		"gdrive:dl": "gdrive:dl/f.zip", "gdrive:dl/": "gdrive:dl/f.zip", "gdrive:": "gdrive:f.zip",
		"sftp:/": "sftp:/f.zip", ":local:/tmp": ":local:/tmp/f.zip",
	}
	if runtime.GOOS != "windows" {
		targets["/tmp/"], targets["/tmp"], targets["/"] = "/tmp/f.zip", "/tmp/f.zip", "/f.zip"
	}
	for dest, want := range targets {
		if got := (DownloadArgs{Destination: dest, Filename: "f.zip"}).Target(); got != want {
			t.Errorf("%s: %s, want %s", dest, got, want)
		}
	}
}

// A plan is stored as JSON and read back unchanged. A plan from a newer build is not read, and
// Check refuses a plan that rclone could not run.
func TestPlanStored(t *testing.T) {
	p := buildOf(t, func() (Plan, error) {
		s := mustSettings(t, "copy", groups("config", `{"transfers": 4}`, "filter", `{"include": "*.jpg", "max_age": "1d"}`))
		return buildCopy(CopyArgs{Sources: []string{"/tmp/photos"}, Destination: "gdrive:in"}, s, Kinds{"/tmp/photos": KindFolder})
	})
	// Landings are for the page, and aren't stored (TestLandings).
	p.Landings = nil
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParsePlan(raw)
	if err != nil || !reflect.DeepEqual(back, p) {
		t.Fatalf("read back %+v %v\nfrom %s", back, err, raw)
	}
	if _, err := ParsePlan([]byte(`{"v":99,"steps":[]}`)); err == nil {
		t.Error("a newer plan was read")
	}
	for name, bad := range map[string]Plan{
		"no steps":         {V: 1},
		"an unknown op":    {V: 1, Steps: []Step{{Op: "format", Src: "/x"}}},
		"a missing path":   {V: 1, Steps: []Step{{Op: OpCopyFile, Src: "/x", Dst: "/y"}}},
		"a bad fs":         {V: 1, Steps: []Step{{Op: OpDelete, Src: ":sftp/x"}}},
		"an unknown opt":   {V: 1, Steps: []Step{{Op: OpDelete, Src: "/x"}}, Config: Options{"nope": "1"}},
		"a bad value":      {V: 1, Steps: []Step{{Op: OpDelete, Src: "/x"}}, Filter: Options{"max_size": "big"}},
		"a bisync in many": {V: 1, Steps: []Step{{Op: OpBisync, Src: "/a", Dst: "/b"}, {Op: OpDelete, Src: "/x"}}},
		"no checkers":      {V: 1, Steps: []Step{{Op: OpDelete, Src: "/x"}}, Config: Options{"checkers": "0"}},
	} {
		if err := bad.Check(); err == nil {
			t.Errorf("%s: checked", name)
		}
	}
}

// A dry run sets dry_run in the config, and bisync's own switch for a bisync. Either one makes
// the plan a dry run.
func TestDryRunPlan(t *testing.T) {
	p := Plan{V: 1, Steps: []Step{{Op: OpCopy, Src: "/a", Dst: "/b"}}, Config: Options{"transfers": "2"}}
	if p.DryRun() {
		t.Fatal("not a dry run yet")
	}
	d := p.WithDryRun()
	if !d.DryRun() || d.Config["transfers"] != "2" || d.Bisync != nil {
		t.Errorf("dry run %+v", d)
	}
	if _, set := p.Config["dry_run"]; set {
		t.Error("the original was changed")
	}
	b := Plan{V: 1, Steps: []Step{{Op: OpBisync, Src: "/a", Dst: "/b"}}}
	if d := b.WithDryRun(); d.Bisync["dryRun"] != true || !d.DryRun() {
		t.Errorf("a bisync's own switch not set: %+v", d)
	}
	b.Bisync = map[string]any{"dryRun": true}
	if !b.DryRun() {
		t.Error("a bisync with its own dryRun switch is not a dry run")
	}
	if (Plan{Config: Options{"dry_run": "false"}}).DryRun() {
		t.Error("dry_run false is a dry run")
	}
}

// A value is stored as the page gave it, so it reads back exactly. rclone's own rendering would
// round an odd size (1234567 bytes becomes 1.177Mi).
func TestStoredValuesExact(t *testing.T) {
	for _, tc := range []struct {
		block, name, json string
	}{
		{blockFilter, "max_size", `1234567`},
		{blockFilter, "max_age", `1500000001`},
		{blockMain, "multi_thread_cutoff", `"1.5Mi"`},
		{blockMain, "tpslimit", `0.3`},
		{blockMain, "bwlimit", `"08:00,512k 12:00,10M 23:00,off"`},
		{blockMain, "max_transfer", `1000`},
	} {
		o, err := decodeOptions(json.RawMessage(`{"` + tc.name + `": ` + tc.json + `}`))
		if err != nil {
			t.Fatal(err)
		}
		stored, err := storedOptions(tc.block, o)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		raw, _ := json.Marshal(stored)
		var back Options
		if err := decodeJSON(raw, &back); err != nil {
			t.Fatal(err)
		}
		want, _ := typedOptions(tc.block, Options(o))
		got, err := typedOptions(tc.block, back)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: stored %s reads back as %v, want %v (%v)", tc.name, raw, got, want, err)
		}
	}
}

// TestLandings: a copy or a move says where each source ends up, the way its steps put it there.
// A folder and a file keep their names inside the destination, a root's entries go straight in,
// and a source inside a selected folder goes with that folder. Landings aren't stored.
func TestLandings(t *testing.T) {
	sources := []string{"gdrive:Photos", "gdrive:notes.txt", "gdrive:Photos/2024", "/tmp/Docs/"}
	k := Kinds{"gdrive:Photos": KindFolder, "gdrive:notes.txt": KindFile, "gdrive:Photos/2024": KindFolder, "/tmp/Docs/": KindFolder}
	for _, build := range []func(CopyArgs) (Plan, error){
		func(a CopyArgs) (Plan, error) { return buildCopy(a, settings{}, k) },
		func(a CopyArgs) (Plan, error) { return buildMove(MoveArgs(a), settings{}, k) },
	} {
		p, err := build(CopyArgs{Sources: sources, Destination: "mem:backup/"})
		if err != nil {
			t.Fatal(err)
		}
		want := []Landing{
			{Source: "gdrive:Photos", Path: "mem:backup/Photos", Name: "Photos", Folder: true},
			{Source: "gdrive:notes.txt", Path: "mem:backup/notes.txt", Name: "notes.txt"},
			{Source: "/tmp/Docs/", Path: "mem:backup/Docs", Name: "Docs", Folder: true},
		}
		if !reflect.DeepEqual(p.Landings, want) {
			t.Errorf("landings %+v\nwant %+v", p.Landings, want)
		}
	}

	// A root's entries go straight into the destination, here a local folder in its own form.
	p, err := buildCopy(CopyArgs{Sources: []string{"gdrive:"}, Destination: "/tmp/in"}, settings{}, Kinds{"gdrive:": KindFolder})
	if err != nil {
		t.Fatal(err)
	}
	if want := []Landing{{Source: "gdrive:", Path: filepath.FromSlash("/tmp/in"), Folder: true, Contents: true}}; !reflect.DeepEqual(p.Landings, want) {
		t.Errorf("root: %+v", p.Landings)
	}
	stored, _ := json.Marshal(p)
	if strings.Contains(string(stored), "gdrive:\",\"path") || strings.Contains(string(stored), "landings") {
		t.Errorf("landings were stored: %s", stored)
	}
}
