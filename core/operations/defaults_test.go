package operations

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/catalog"
)

// serveDefaultFlags are the flags of the app's defaults for a serve that sets none of them: the
// config group's, sorted by name.
var serveDefaultFlags = []string{"--checkers=16", "--transfers=8"}

// A plan gets the app's defaults for its operation under the page's own options. A null names an
// option without a value, so its default is left out and rclone's own applies.
func TestPlanDefaults(t *testing.T) {
	dir, folder, file := localTree(t)
	ctx := context.Background()
	build := func(f Form) Plan {
		t.Helper()
		p, err := BuildPlan(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	copyOf := func(g Groups) Form {
		return CopyArgs{Sources: []string{folder}, Destination: dir + "/out", Options: g}.Form()
	}

	p := build(copyOf(Groups{}))
	for name, want := range map[string]string{"transfers": "8", "checkers": "16", "multi_thread_streams": "8"} {
		if got := p.Config[name]; got != want {
			t.Errorf("copy with no options: %s is %v, want %s", name, got, want)
		}
	}
	// Those three are the app's only defaults. Everything else is rclone's own.
	if len(p.Config) != 3 {
		t.Errorf("copy with no options: config %v, want the three defaults only", p.Config)
	}

	form := copyOf(groups("config", `{"transfers": null}`))
	if p := build(form); p.Config["transfers"] != nil || p.Config["checkers"] != "16" {
		t.Errorf("a null for transfers: config %v", p.Config)
	}
	if _, ok := form.Copy.Options.Config["checkers"]; ok {
		t.Error("building the plan added the defaults to the form")
	}
	// The page's own value wins, in whichever group the page put it.
	if p := build(copyOf(groups("copy", `{"transfers": 4}`))); p.Config["transfers"] != "4" {
		t.Errorf("copy's own transfers: config %v", p.Config)
	}

	// A purge reads only its config group, and has no multi-thread default.
	p = build(PurgeArgs{Sources: []string{folder}}.Form())
	if p.Config["transfers"] != "8" || p.Config["multi_thread_streams"] != nil {
		t.Errorf("purge: config %v", p.Config)
	}
	// A download has no defaults.
	p = build(DownloadArgs{URL: "https://example.com/x", Filename: "x", Destination: dir}.Form())
	if len(p.Config) != 0 {
		t.Errorf("download: config %v", p.Config)
	}
	// A save from the Commander gets a copy's defaults, in its config group.
	p = build(SaveArgs{Source: file, Destination: dir + "/saved.txt"}.Form())
	if p.Config["transfers"] != "8" || p.Config["multi_thread_streams"] != "8" {
		t.Errorf("save: config %v", p.Config)
	}

	// A template's card runs with the defaults too, and its own options win.
	f, err := TemplateArgs(OperationSync, []string{folder}, dir+"/synced",
		catalog.Group{"checkers": json.RawMessage(`4`), "transfers": json.RawMessage(`null`)})
	if err != nil {
		t.Fatal(err)
	}
	p = build(f)
	if p.Config["checkers"] != "4" || p.Config["transfers"] != nil || p.Config["multi_thread_streams"] != "8" {
		t.Errorf("a template's sync: config %v", p.Config)
	}

	// The script shows the defaults, and leaves a null out.
	script, err := build(copyOf(groups("config", `{"checkers": null}`))).Script(testExe, "linux", "")
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Join(script.Lines, "\n")
	if !strings.Contains(line, "--transfers=8") || strings.Contains(line, "--checkers") ||
		!strings.Contains(script.SDK, "Transfers: 8,") || strings.Contains(script.SDK, "Checkers") {
		t.Errorf("script %q\nprogram:\n%s", script.Lines, script.SDK)
	}
}

// A mount gets the config group's defaults and none for its vfs group, so its cache is rclone's
// own default unless the user sets one. The program of the Copy command shows the same defaults
// as the command line.
func TestMountDefaults(t *testing.T) {
	env := MountEnv{OS: "linux"}
	m, err := MountCommand(MountArgs{Source: "gdrive:photos", Destination: "/mnt/photos"}, env)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(m.Flags, []string{"--checkers=16", "--transfers=8"}) {
		t.Errorf("flags %q", m.Flags)
	}
	m, err = MountCommand(MountArgs{Source: "gdrive:photos", Destination: "/mnt/photos",
		Options: groups("config", `{"transfers": null}`)}, env)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(m.Flags, []string{"--checkers=16"}) {
		t.Errorf("a null for transfers: flags %q", m.Flags)
	}

	script, err := MountScript(MountArgs{Source: "gdrive:photos", Destination: "/mnt/photos",
		Options: groups("config", `{"checkers": null}`)}, env, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(script.Lines[0], "--transfers=8") || !strings.Contains(script.SDK, "Transfers: 8,") {
		t.Errorf("the transfers default is missing: %q\n%s", script.Lines[0], script.SDK)
	}
	if strings.Contains(script.Lines[0], "checkers") || strings.Contains(script.SDK, "Checkers") {
		t.Errorf("a null for checkers became a flag: %q\n%s", script.Lines[0], script.SDK)
	}
	if strings.Contains(script.Lines[0], "vfs") || strings.Contains(script.SDK, "vfs_") {
		t.Errorf("a mount has a vfs default: %q\n%s", script.Lines[0], script.SDK)
	}
}

// A serve's program shows the defaults too.
func TestServeDefaults(t *testing.T) {
	script, err := ServeScript(ServeArgs{Source: "/srv", Type: "webdav"}, ServeEnv{}, "linux", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Checkers: 16,", "Transfers: 8,"} {
		if !strings.Contains(script.SDK, want) {
			t.Errorf("program has no %q:\n%s", want, script.SDK)
		}
	}
}

// Any spelling of an option's name counts, and so does a group other than the default's.
// withDefaults leaves the groups that it was given unchanged.
func TestWithDefaults(t *testing.T) {
	g := groups("config", `{"--multi-thread-streams": 2}`, "copy", `{"transfers": 2}`, "remotes", `{"gdrive": {"checkers": 1}}`)
	out := withDefaults(OperationCopy, g)
	if _, ok := out.Copy["multi_thread_streams"]; ok {
		t.Errorf("a dashed spelling didn't count: %v", out.Copy)
	}
	if _, ok := out.Config["transfers"]; ok {
		t.Errorf("transfers in the copy group didn't count: %v", out.Config)
	}
	// A remote's own override isn't one of rclone's options for the operation.
	if string(out.Config["checkers"]) != "16" {
		t.Errorf("defaults %v %v", out.Config, out.Copy)
	}
	if len(g.Config) != 1 || len(g.Copy) != 1 {
		t.Errorf("the groups given changed: %v %v", g.Config, g.Copy)
	}
	if out := withDefaults(OperationDownload, Groups{}); len(out.Config) != 0 {
		t.Errorf("download: %v", out.Config)
	}
}
