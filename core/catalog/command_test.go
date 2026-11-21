package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/filter"

	"github.com/rclone/rclone-ui/core/errs"
)

func TestSplitCommand(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []string
	}{
		{`rclone sync a: b:`, []string{"rclone", "sync", "a:", "b:"}},
		{`  --exclude "*.tmp"   --include '*.jpg' `, []string{"--exclude", "*.tmp", "--include", "*.jpg"}},
		{`--exclude="a b" x\ y`, []string{"--exclude=a b", "x y"}},
		{`--header "X-A: \"q\""`, []string{"--header", `X-A: "q"`}},
		{`'it''s'`, []string{"its"}},
		{`""`, []string{""}},
		{"sync a: \\\n  b: --dry-run", []string{"sync", "a:", "b:", "--dry-run"}},
		{`copy C:\Users\me\Photos D:\Backup`, []string{"copy", `C:\Users\me\Photos`, `D:\Backup`}},
		{`copy "C:\Program Files\x" y:`, []string{"copy", `C:\Program Files\x`, "y:"}},
	} {
		got, err := splitCommand(c.in)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("splitCommand(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{`--exclude "*.tmp`, `'open`} {
		if _, err := splitCommand(bad); !errors.Is(err, ErrCommand) {
			t.Errorf("splitCommand(%q): %v", bad, err)
		}
	}
}

func groupOf(t *testing.T, out *ParsedCommand, name string) map[string]any {
	t.Helper()
	group, ok := out.Groups[name]
	if !ok {
		return nil
	}
	var g map[string]any
	if err := json.Unmarshal(marshal(group), &g); err != nil {
		t.Fatalf("group %s: %v", name, err)
	}
	return g
}

func skipped(out *ParsedCommand) map[string]string {
	m := map[string]string{}
	for _, s := range out.Skipped {
		m[s.Flag] = s.Reason
	}
	return m
}

func TestParseCommand(t *testing.T) {
	ciBefore := *fs.GetConfig(context.Background())
	fiBefore := filter.GetConfig(context.Background()).Opt
	s := New("")
	out, err := s.ParseCommand(`/usr/local/bin/rclone -vv sync --delete-after gdrive:Photos "/Volumes/Backup/My Photos" ` +
		`--transfers 8 -P --exclude "*.tmp" --exclude=.DS_Store --fast-list --dry-run --bwlimit 1M ` +
		`--max-delete 10 --metadata --max-age 2d --size-only=false --drive-chunk-size 64M --no-such-flag --help`)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(out.Args, []string{"sync", "gdrive:Photos", "/Volumes/Backup/My Photos"}) {
		t.Errorf("args %q", out.Args)
	}
	if got := groupOf(t, out, "config"); !reflect.DeepEqual(got, map[string]any{"transfers": 8.0, "fast_list": true, "dry_run": true}) {
		t.Errorf("config %v", got)
	}
	if got := groupOf(t, out, "filter"); !reflect.DeepEqual(got, map[string]any{"exclude": []any{"*.tmp", ".DS_Store"}, "max_age": "2d"}) {
		t.Errorf("filter %v", got)
	}
	if got := groupOf(t, out, "sync"); !reflect.DeepEqual(got, map[string]any{"max_delete": 10.0}) {
		t.Errorf("sync %v", got)
	}
	if got := groupOf(t, out, "copy"); !reflect.DeepEqual(got, map[string]any{"size_only": false}) {
		t.Errorf("copy %v", got)
	}
	if got := groupOf(t, out, "metadata"); !reflect.DeepEqual(got, map[string]any{"metadata": true}) {
		t.Errorf("metadata %v", got)
	}
	why := skipped(out)
	for flag, reason := range map[string]string{
		"--bwlimit":          reasonSettings.String(),
		"--drive-chunk-size": reasonBackend.String(),
		"--no-such-flag":     reasonUnknown.String(),
		"--verbose":          reasonCLI.String(),
		"--delete-after":     reasonCLI.String(),
		"--help":             reasonCLI.String(),
		"--progress":         reasonCLI.String(),
	} {
		if why[flag] != reason {
			t.Errorf("%s skipped as %q, want %q (all %v)", flag, why[flag], reason, why)
		}
	}
	// None of the flags changed rclone's own settings.
	if ci := fs.GetConfig(context.Background()); ci.Transfers != ciBefore.Transfers || ci.DryRun != ciBefore.DryRun || ci.Progress != ciBefore.Progress {
		t.Errorf("rclone's config changed: transfers %d dry-run %v", ci.Transfers, ci.DryRun)
	}
	if fi := filter.GetConfig(context.Background()).Opt; !reflect.DeepEqual(fi.ExcludeRule, fiBefore.ExcludeRule) {
		t.Errorf("rclone's filters changed: %v", fi.ExcludeRule)
	}
	for _, o := range fs.ConfigOptionsInfo {
		if o.IsSet() {
			t.Errorf("rclone's %s marked set", o.Name)
		}
	}
}

// A pasted Copy command puts this executable in front of the app's own metadata mapper, and the
// import removes it again. Another program's mapper is kept whole.
func TestParseCommandMapper(t *testing.T) {
	const exe = "/opt/Rclone UI/rcui"
	s := New(exe)
	out, err := s.ParseCommand(`rclone copy a: b: --metadata --metadata-mapper '"/opt/Rclone UI/rcui" metadata-map --map "a b=c"'`)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, out, "metadata")["metadata_mapper"]; !reflect.DeepEqual(got, []any{"metadata-map", "--map", "a b=c"}) {
		t.Errorf("own mapper %v", got)
	}
	out, err = s.ParseCommand(`rclone copy a: b: --metadata-mapper "/opt/bin/mapper -v"`)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, out, "metadata")["metadata_mapper"]; !reflect.DeepEqual(got, []any{"/opt/bin/mapper", "-v"}) {
		t.Errorf("another program %v", got)
	}
}

func TestParseCommandServeAndValues(t *testing.T) {
	s := New("")
	out, err := s.ParseCommand(`rclone serve webdav remote: --addr :8080 --vfs-cache-mode full --read-only --dir-cache-time 5m --transfers nope`)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, out, "serve.webdav"); got["addr"] == nil || got["addr"].([]any)[0] != ":8080" {
		t.Errorf("serve.webdav %v", got)
	}
	vfs := groupOf(t, out, "vfs")
	// Values keep the text as written, which rclone has parsed, rather than rclone's rendering of
	// it (5m0s).
	if vfs["vfs_cache_mode"] != "full" || vfs["read_only"] != true || vfs["dir_cache_time"] != "5m" {
		t.Errorf("vfs %v", vfs)
	}
	if why := skipped(out)["--transfers"]; why == "" {
		t.Errorf("a bad value taken: %v", out.Skipped)
	}
	// A serve's options are only taken from that serve's command. --addr in any other command
	// isn't an option that a page sets.
	out, err = s.ParseCommand(`sync a: b: --addr :8080`)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Groups) != 0 || skipped(out)["--addr"] != reasonNoGroup.String() {
		t.Errorf("groups %v skipped %v", out.Groups, out.Skipped)
	}
	if _, err := s.ParseCommand(`sync a: b: --transfers`); errs.FieldOf(err) != "command" || !strings.HasPrefix(err.Error(), ErrCommand.Error()) {
		t.Errorf("a flag without its value: %v", err)
	}
}
