package main

import (
	"slices"
	"testing"

	rclonecmd "github.com/rclone/rclone/cmd"
)

func TestDispatch(t *testing.T) {
	for _, c := range []struct {
		argv0 string
		args  []string
		want  role
	}{
		{"/Applications/Rclone UI.app/Contents/MacOS/rcui", nil, roleUI},
		{"rcui", []string{"ui"}, roleUI},
		{"rcui", []string{"rclone://add-template?x=1"}, roleUI},
		// Any number of slashes is accepted, as in deeplink.Parse.
		{"rcui", []string{"rclone:add-template?x=1"}, roleUI},
		{"rcui", []string{"RCLONE:/add-template?x=1"}, roleUI},
		{"rcui", []string{"-psn_0_12345"}, roleUI},
		{"rcui", []string{"core"}, roleRclone},
		{"rcui", []string{"metadata-map", "a"}, roleMapper},
		{"rcui", []string{"mcp"}, roleAgents},
		{"rclone", []string{"mcp"}, roleRclone},
		{"rcui", []string{"tunnel"}, roleRclone},
		{"rcui", []string{"rcd", "--rc-addr", ":5572"}, roleRclone},
		{"rcui", []string{"mount", "a:", "/mnt"}, roleRclone},
		{`C:\Program Files\Rclone UI\rcui.exe`, []string{"cat", "a:b"}, roleRclone},
		{"/usr/local/bin/rclone", nil, roleRclone},
		{"/usr/local/bin/rclone", []string{"core"}, roleRclone},
		{`C:\bin\rclone.exe`, []string{"ui"}, roleRclone},
	} {
		if got, _ := dispatch(c.argv0, c.args); got != c.want {
			t.Errorf("dispatch(%q, %q) = %v, want %v", c.argv0, c.args, got, c.want)
		}
	}
}

func TestCalledAs(t *testing.T) {
	env := func(vars map[string]string) func(string) string {
		return func(k string) string { return vars[k] }
	}
	exe := "/tmp/.mount_rcuiXYZ/usr/bin/rcui"
	for _, c := range []struct {
		vars map[string]string
		want string
	}{
		{map[string]string{"APPIMAGE": "/home/me/Rclone_UI.AppImage", "ARGV0": "rclone"}, "rclone"},
		{map[string]string{"APPIMAGE": "/home/me/Rclone_UI.AppImage", "ARGV0": "/home/me/.local/bin/rclone"}, "/home/me/.local/bin/rclone"},
		{map[string]string{"APPIMAGE": "/home/me/Rclone_UI.AppImage"}, exe},
		// $ARGV0 means nothing outside an AppImage.
		{map[string]string{"ARGV0": "rclone"}, exe},
	} {
		if got := calledAs(exe, env(c.vars)); got != c.want {
			t.Errorf("calledAs with %v = %q, want %q", c.vars, got, c.want)
		}
	}
	if r, _ := dispatch(calledAs(exe, env(map[string]string{"APPIMAGE": "/x.AppImage", "ARGV0": "rclone"})), nil); r != roleRclone {
		t.Errorf("a bare rclone through the AppImage's link is %v, want rclone", r)
	}
}

// main hasn't added its own commands (tunnel, update) in this test, so the commands that are
// checked are rclone's own.
func TestRoleWordsAreNotRcloneCommands(t *testing.T) {
	for _, c := range rclonecmd.Root.Commands() {
		for _, name := range append([]string{c.Name()}, c.Aliases...) {
			switch name {
			case "ui", "metadata-map", "mcp", "tunnel", "update":
				t.Errorf("rclone registers a command named %q, which rcui takes", name)
			}
		}
	}
}

func TestWithConfig(t *testing.T) {
	const conf = `D:\Rclone UI\rclone.conf`
	unset := func(string) (string, bool) { return "", false }
	for _, c := range []struct {
		args []string
		want []string
	}{
		{nil, []string{"--config=" + conf}},
		{[]string{"config", "file"}, []string{"--config=" + conf, "config", "file"}},
		{[]string{"ls", "a:", "--config", "team.conf"}, []string{"ls", "a:", "--config", "team.conf"}},
		{[]string{"--config=team.conf", "ls", "a:"}, []string{"--config=team.conf", "ls", "a:"}},
		{[]string{"lsf", "a:", "--", "--config"}, []string{"--config=" + conf, "lsf", "a:", "--", "--config"}},
		// A flag whose name only starts with "config" isn't --config.
		{[]string{"ls", "a:", "--config-dir=x"}, []string{"--config=" + conf, "ls", "a:", "--config-dir=x"}},
	} {
		if got := withConfig(slices.Clone(c.args), conf, unset); !slices.Equal(got, c.want) {
			t.Errorf("withConfig(%q) = %q, want %q", c.args, got, c.want)
		}
	}
	// RCLONE_CONFIG is set, even when it is empty, which rclone reads as a config in memory.
	for _, value := range []string{`C:\team.conf`, ""} {
		set := func(name string) (string, bool) { return value, name == "RCLONE_CONFIG" }
		if got := withConfig([]string{"ls", "a:"}, conf, set); !slices.Equal(got, []string{"ls", "a:"}) {
			t.Errorf("with RCLONE_CONFIG=%q: %q", value, got)
		}
	}
}
