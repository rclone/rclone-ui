package operations

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/flags"
	"github.com/spf13/pflag"

	"github.com/rclone/rclone-ui/core/rclone"
)

// withoutRcloneEnv unsets every RCLONE_* variable for the test. flags.AddFlagsFromOptions reads
// them into the flags that it adds, and it ends the process with fs.Fatalf on a value it refuses.
func withoutRcloneEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, "RCLONE_") {
			t.Setenv(name, value) // restored after the test
			_ = os.Unsetenv(name)
		}
	}
}

// childFlagSet builds a child's command line flags the way rclone does. It adds the global
// blocks (the configflags, filterflags, rcflags and logflags of cmd.Main) and the command's own
// blocks, each without a prefix, using flags.AddFlagsFromOptions. That function sets NoPrefix on
// the options it is given, so it gets copies (slices.Clone) and the registry stays unchanged.
func childFlagSet(t *testing.T, blocks ...string) *pflag.FlagSet {
	t.Helper()
	set := pflag.NewFlagSet("child", pflag.ContinueOnError)
	for _, b := range append([]string{"main", "filter", "rc", "log"}, blocks...) {
		oi, ok := fs.OptionsRegistry[b]
		if !ok {
			t.Fatalf("no %s options", b)
		}
		flags.AddFlagsFromOptions(set, "", slices.Clone(oi.Options))
	}
	return set
}

// sampleValue returns a value to render an option's flag with. It uses the default's text when
// there is one, or else one of the examples or bit names, or else the first of a few texts that
// rclone accepts.
func sampleValue(o *fs.Option) []any {
	c := o.Copy()
	c.Value = nil
	var out []any
	if text := c.String(); strings.TrimSpace(text) != "" {
		out = append(out, text)
	}
	for _, ex := range o.Examples {
		out = append(out, ex.Value)
	}
	if bits, ok := o.Default.(interface{ Choices() []fs.BitsChoicesInfo }); ok {
		for _, b := range bits.Choices() {
			out = append(out, b.Name)
		}
	}
	return append(out, "1", "true", "x", []any{"x"}, "1s", "off")
}

// Every option that the Mount and Serve pages offer renders to a flag that the child's command
// line accepts. This covers the mount, vfs and filter blocks, the main options, the block of each
// serve type, and the auth proxy's block.
func TestFlagNames(t *testing.T) {
	withoutRcloneEnv(t)
	children := map[string][]string{"mount": {"mount", "vfs"}}
	for _, typ := range rclone.ServeTypes() {
		children["serve "+typ] = []string{typ, "vfs", "proxy"}
	}
	for child, blocks := range children {
		set := childFlagSet(t, blocks...)
		for _, b := range append([]string{"main", "filter"}, blocks...) {
			for i := range fs.OptionsRegistry[b].Options {
				o := &fs.OptionsRegistry[b].Options[i]
				if _, refused := childFlags[o.Name]; refused {
					continue
				}
				var rendered []string
				for _, v := range sampleValue(o) {
					if args, err := renderFlag(o, v, "/opt/rcui"); err == nil && len(args) > 0 {
						rendered = args
						break
					}
				}
				if rendered == nil {
					t.Errorf("%s: %s.%s renders no flag", child, b, o.Name)
					continue
				}
				name, _, _ := strings.Cut(strings.TrimPrefix(rendered[0], "--"), "=")
				if set.Lookup(name) == nil {
					t.Errorf("%s: %s.%s renders as --%s, which the child does not know", child, b, o.Name, name)
				}
			}
		}
	}
	// The registry is unchanged, so a bare FlagName("") on the main block is still not a flag.
	if o := fs.OptionsRegistry["main"].Options.Get("fast_list"); o.NoPrefix || flagName(o) != "fast-list" {
		t.Errorf("fast_list: NoPrefix %v, flag %s", o.NoPrefix, flagName(o))
	}
}

// Every option that a page can put on a command line parses back from its flag to the same
// value. The test renders the default's text and parses it the way the child's flag does
// (fs.Option.Set).
func TestFlagRoundTripText(t *testing.T) {
	for _, block := range []string{"main", "filter", "vfs", "mount", "proxy"} {
		for i := range fs.OptionsRegistry[block].Options {
			o := &fs.OptionsRegistry[block].Options[i]
			c := o.Copy()
			c.Value = nil
			text := c.String()
			if strings.TrimSpace(text) == "" || o.Name == "metadata_mapper" {
				continue
			}
			var v any = text
			if list, ok := o.Default.([]string); ok {
				v = anyList(list)
			}
			args, err := renderFlag(o, v, "")
			if err != nil {
				t.Errorf("%s.%s: %v", block, o.Name, err)
				continue
			}
			parsed := o.Copy()
			parsed.Value = nil
			for _, arg := range args {
				if err := parsed.Set(strings.SplitN(arg, "=", 2)[1]); err != nil {
					t.Errorf("%s.%s: %s: %v", block, o.Name, arg, err)
				}
			}
			if !reflect.DeepEqual(parsed.GetValue(), o.Default) {
				t.Errorf("%s.%s: %q reads back as %v, want %v", block, o.Name, args, parsed.GetValue(), o.Default)
			}
		}
	}
}

// A flag carries the page's text unchanged. A repeated flag gets one flag per element. A comma
// list or an argv given as elements is written the way rclone writes the list.
func TestRenderFlagTexts(t *testing.T) {
	opt := func(block, name string) *fs.Option { return fs.OptionsRegistry[block].Options.Get(name) }
	for _, c := range []struct {
		o    *fs.Option
		v    any
		want []string
	}{
		{opt("vfs", "dir_cache_time"), "5m", []string{"--dir-cache-time=5m"}},
		{opt("vfs", "vfs_cache_max_size"), "1234567B", []string{"--vfs-cache-max-size=1234567B"}},
		{opt("vfs", "vfs_cache_max_size"), json.Number("1000"), []string{"--vfs-cache-max-size=1000"}},
		{opt("main", "transfers"), json.Number("8"), []string{"--transfers=8"}},
		{opt("main", "fast_list"), true, []string{"--fast-list=true"}},
		{opt("filter", "exclude"), "*.{jpg,png}", []string{"--exclude=*.{jpg,png}"}},
		{opt("filter", "exclude"), []any{"a", "b"}, []string{"--exclude=a", "--exclude=b"}},
		{opt("main", "metadata_mapper"), []any{"/usr/bin/my mapper", "-v"}, []string{`--metadata-mapper="/usr/bin/my mapper" -v`}},
		{opt("main", "metadata_mapper"), `"/usr/bin/my mapper" -v`, []string{`--metadata-mapper="/usr/bin/my mapper" -v`}},
	} {
		got, err := renderFlag(c.o, c.v, "/opt/rcui")
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%s %v: %q %v, want %q", c.o.Name, c.v, got, err, c.want)
		}
	}
	for _, c := range []struct {
		o    *fs.Option
		v    any
		want string
	}{
		{opt("vfs", "read_only"), json.Number("3"), `read_only: parsing "3" as bool failed`},
		{opt("vfs", "vfs_cache_mode"), []any{"full"}, "vfs_cache_mode: takes one value, not a list"},
		{opt("vfs", "dir_cache_time"), "soon", "dir_cache_time"},
	} {
		if _, err := renderFlag(c.o, c.v, ""); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %v: %v, want an error with %q", c.o.Name, c.v, err, c.want)
		}
	}
}
