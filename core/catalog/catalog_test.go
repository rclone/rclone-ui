package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/all"
	_ "github.com/rclone/rclone/cmd/all"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

func backend(t *testing.T, c *Catalog, name string) *Backend {
	t.Helper()
	for i := range c.Backends {
		if c.Backends[i].Name == name {
			return &c.Backends[i]
		}
	}
	t.Fatalf("no backend %s", name)
	return nil
}

func option(t *testing.T, opts []Option, name string) *Option {
	t.Helper()
	for i := range opts {
		if opts[i].Name == name {
			return &opts[i]
		}
	}
	t.Fatalf("no option %s", name)
	return nil
}

func block(t *testing.T, c *Catalog, name string) []Option {
	t.Helper()
	for _, b := range c.Blocks {
		if b.Name == name {
			return b.Options
		}
	}
	t.Fatalf("no block %s", name)
	return nil
}

func group(t *testing.T, c *Catalog, name string) []OptionRef {
	t.Helper()
	for _, g := range c.Groups {
		if g.Name == name {
			return g.Options
		}
	}
	t.Fatalf("no group %s", name)
	return nil
}

func values(cs []Choice) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.Value)
	}
	return out
}

func names(refs []OptionRef) []string {
	var out []string
	for _, r := range refs {
		out = append(out, r.Name)
	}
	return out
}

func TestKinds(t *testing.T) {
	c := New("").Catalog()
	drive := backend(t, c, "drive").Options
	for _, tc := range []struct {
		opts       []Option
		name       string
		kind       Kind
		defaultTxt string
	}{
		{drive, "pacer_min_sleep", KindDuration, "100ms"},
		{drive, "chunk_size", KindSize, "8Mi"},
		{drive, "encoding", KindFlags, "InvalidUtf8"},
		{drive, "metadata_labels", KindFlags, "off"},
		{drive, "pacer_burst", KindInt, "100"},
		{drive, "use_trash", KindBool, "true"},
		{backend(t, c, "swift").Options, "use_segments_container", KindTristate, "unset"},
		{backend(t, c, "dropbox").Options, "export_formats", KindList, "html,md"},
		{backend(t, c, "onedrive").Options, "access_scopes", KindList, ""},
		{backend(t, c, "s3").Options, "version_at", KindTime, "off"},
		{backend(t, c, "local").Options, "time_type", KindChoice, "mtime"},
		{backend(t, c, "zoho").Options, "tpslimit", KindFloat, ""},
		{block(t, c, "vfs"), "vfs_cache_mode", KindChoice, "off"},
		{block(t, c, "vfs"), "umask", KindFileMode, ""},
		{block(t, c, "main"), "bwlimit", KindBwTimetable, ""},
		{block(t, c, "main"), "metadata_mapper", KindList, ""},
		{block(t, c, "filter"), "include", KindList, ""},
		{block(t, c, "main"), "cutoff_mode", KindChoice, "HARD"},
	} {
		o := option(t, tc.opts, tc.name)
		if o.Kind != tc.kind {
			t.Errorf("%s: kind %v, want %v (type %s)", tc.name, o.Kind, tc.kind, o.Type)
		}
		if tc.defaultTxt != "" && o.DefaultText != tc.defaultTxt {
			t.Errorf("%s: default %q, want %q", tc.name, o.DefaultText, tc.defaultTxt)
		}
	}

	// Every backend option has a kind, so a form shows more than bools and strings.
	for _, b := range c.Backends {
		for _, o := range b.Options {
			if o.Kind == "" {
				t.Errorf("%s.%s: no kind", b.Name, o.Name)
			}
			if o.Kind == KindText && o.Type != "string" {
				t.Errorf("%s.%s: type %s shown as text", b.Name, o.Name, o.Type)
			}
		}
	}

	if got := values(option(t, block(t, c, "vfs"), "vfs_cache_mode").Choices); !slices.Equal(got, []string{"off", "minimal", "writes", "full"}) {
		t.Errorf("cache modes %v", got)
	}
	enc := option(t, drive, "encoding")
	if !slices.Contains(values(enc.Choices), "Slash") || !slices.Contains(values(enc.Choices), "InvalidUtf8") {
		t.Errorf("encodings %v", values(enc.Choices))
	}
	if got := values(option(t, backend(t, c, "swift").Options, "use_segments_container").Choices); !slices.Equal(got, []string{"unset", "true", "false"}) {
		t.Errorf("tristate %v", got)
	}
	// Examples first, then the presets.
	provider := option(t, backend(t, c, "s3").Options, "provider")
	if len(provider.Choices) < 10 || provider.Choices[0].Help == "" {
		t.Errorf("s3 provider examples %v", values(provider.Choices))
	}
	chunk := option(t, drive, "chunk_size")
	if !slices.Contains(values(chunk.Choices), "64M") {
		t.Errorf("size presets %v", values(chunk.Choices))
	}
	if o := option(t, backend(t, c, "sftp").Options, "key_file"); o.Path != PathFile {
		t.Errorf("key_file path %v", o.Path)
	}
	if o := option(t, backend(t, c, "sftp").Options, "pass"); !o.Password {
		t.Error("sftp pass is not a password")
	}
	// An alias that rclone registers for a renamed backend (tardigrade for storj) isn't offered
	// by any form.
	if !backend(t, c, "tardigrade").Hidden || backend(t, c, "storj").Hidden {
		t.Error("tardigrade offered, or storj not")
	}
}

func TestDefaultText(t *testing.T) {
	// The default uses rclone's own text, so a bare size keeps its unit and reads back as the
	// same size.
	o := &fs.Option{Name: "x", Default: fs.SizeSuffix(100)}
	if got := defaultText(o); got != "100B" {
		t.Errorf("size %q", got)
	}
	// A value set by a flag is not the default.
	o.Value = fs.SizeSuffix(200)
	if got := defaultText(o); got != "100B" {
		t.Errorf("with a value %q", got)
	}
	if got := defaultText(&fs.Option{Name: "l", Default: []string{"a b", "c"}}); got != "a b,c" {
		t.Errorf("list %q", got)
	}
}

// The catalog's backends have the choices of every provider, with each value once. us-east-1
// belongs to AWS and to other providers, and it keeps the first one's help.
func TestChoicesOnce(t *testing.T) {
	region := option(t, backend(t, New("").Catalog(), "s3").Options, "region")
	seen := map[string]bool{}
	for _, ch := range region.Choices {
		if seen[ch.Value] {
			t.Fatalf("region %s twice", ch.Value)
		}
		seen[ch.Value] = true
	}
	if !seen["us-east-1"] || !seen["de"] {
		t.Errorf("regions %v", values(region.Choices))
	}
}

func TestFromOption(t *testing.T) {
	// A config session's yes/no question.
	out, _ := fs.ConfigConfirm("state", true, "config_change_team_drive", "Configure this as a Shared Drive?")
	q := FromOption(out.Option)
	if q.Name != "config_change_team_drive" || q.Kind != KindBool || q.DefaultText != "true" {
		t.Errorf("confirm %+v", q)
	}
	if got := values(q.Choices); !slices.Equal(got, []string{"true", "false"}) {
		t.Errorf("confirm choices %v", got)
	}
}

func TestGroups(t *testing.T) {
	c := New("").Catalog()
	main := block(t, c, "main")
	if o := option(t, main, "bwlimit"); o.PerOperation {
		t.Error("bwlimit per operation")
	}
	if o := option(t, main, "checkers"); !o.PerOperation {
		t.Error("checkers not per operation")
	}
	config := names(group(t, c, "config"))
	for _, name := range []string{"checkers", "transfers", "use_server_modtime", "fast_list"} {
		if !slices.Contains(config, name) {
			t.Errorf("config group lacks %s", name)
		}
	}
	for _, name := range rclone.NotPerOperation {
		if slices.Contains(config, name) {
			t.Errorf("config group offers %s, which a job does not apply", name)
		}
	}
	copyNames, syncNames := names(group(t, c, "copy")), names(group(t, c, "sync"))
	for _, name := range copyNames {
		if !slices.Contains(syncNames, name) {
			t.Errorf("sync group lacks copy's %s", name)
		}
	}
	metadata := group(t, c, "metadata")
	for _, want := range []struct{ Block, Name string }{{"main", "metadata"}, {"main", "metadata_mapper"}, {"filter", "metadata_include"}} {
		if !slices.ContainsFunc(metadata, func(r OptionRef) bool { return r.Block == want.Block && r.Name == want.Name }) {
			t.Errorf("metadata group lacks %s.%s", want.Block, want.Name)
		}
	}
	if slices.Contains(names(group(t, c, "filter")), "metadata_include") {
		t.Error("filter group has a metadata rule")
	}
	for _, g := range c.Groups {
		if !slices.IsSortedFunc(names(g.Options), byName) {
			t.Errorf("group %s not sorted", g.Name)
		}
	}
	// There is a group for each serve type built into rclone here (nfs only on Unix), and no
	// others.
	var serves []string
	for _, g := range c.Groups {
		if typ, ok := strings.CutPrefix(g.Name, "serve."); ok {
			serves = append(serves, typ)
		}
	}
	if !slices.Equal(serves, rclone.ServeTypes()) || len(serves) < 7 {
		t.Errorf("serve groups %v, rclone's serves %v", serves, rclone.ServeTypes())
	}
	for _, typ := range serves {
		opts := block(t, c, typ)
		if len(group(t, c, "serve."+typ)) == 0 {
			t.Errorf("serve %s: no options", typ)
		}
		for _, o := range opts {
			if o.Name == "addr" && strings.ContainsAny(o.DefaultText, "[]") {
				t.Errorf("serve %s addr default %q", typ, o.DefaultText)
			}
		}
	}
	if c.Version == "" || New("").Catalog().Version != c.Version {
		t.Errorf("version %q not stable", c.Version)
	}
}

func TestByName(t *testing.T) {
	in := []string{"a1", "ab", "a_b", "a"}
	slices.SortFunc(in, byName)
	if got := strings.Join(in, ","); got != "a,a_b,a1,ab" {
		t.Errorf("order %s, want localeCompare's a,a_b,a1,ab", got)
	}
}

func TestValues(t *testing.T) {
	if v := New("").Values(context.Background()); v.Blocks == nil {
		t.Error("no blocks map")
	}
	// rclone's current values come as text, by option name. The nanoseconds and bytes in the rc
	// JSON are not what a form shows.
	ci := fs.GetConfig(context.Background())
	before := ci.ConnectTimeout
	ci.ConnectTimeout = fs.Duration(90 * time.Second)
	defer func() { ci.ConnectTimeout = before }()
	main := New("").Values(context.Background()).Blocks["main"].Text
	if main["contimeout"] != "1m30s" {
		t.Errorf("main texts %v", main)
	}
	if _, ok := main["transfers"]; ok {
		t.Errorf("a default's text %v", main)
	}

	if lists := New("").Values(context.Background()).Blocks["main"].Lists; lists != nil {
		t.Errorf("lists with no list set %v", lists)
	}

	// A list comes as its elements, as rclone holds them, as well as its text. This covers an
	// argv (a SpaceSepList) with a quoted word, and a comma list with a comma inside one element.
	beforeMapper := ci.MetadataMapper
	ci.MetadataMapper = fs.SpaceSepList{"/usr/bin/mapper", "a b", "-v"}
	defer func() { ci.MetadataMapper = beforeMapper }()
	main2 := New("").Values(context.Background()).Blocks["main"]
	if got := main2.Text["metadata_mapper"]; got != `/usr/bin/mapper "a b" -v` {
		t.Errorf("mapper text %q", got)
	}
	if got := main2.Lists["metadata_mapper"].Values; !slices.Equal(got, []string{"/usr/bin/mapper", "a b", "-v"}) {
		t.Errorf("mapper elements %q", got)
	}

	// A serve's values are keyed by option name too (the Go field is Addrs), and a repeated
	// flag comes as its elements.
	oi := fs.OptionsRegistry["webdav"]
	addr := oi.Options.Get("addr")
	if addr == nil || addr.FieldName == addr.Name {
		t.Fatalf("webdav's addr %+v", addr)
	}
	if err := configstruct.Set(configmap.Simple{"addr": `127.0.0.1:9999,"[::1]:8,0"`}, oi.Opt); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = configstruct.Set(configmap.Simple{"addr": defaultText(addr)}, oi.Opt) }()
	webdav := New("").Values(context.Background()).Blocks["webdav"]
	if got := webdav.Text; got["addr"] != `127.0.0.1:9999,"[::1]:8,0"` {
		t.Errorf("webdav texts %v", got)
	}
	if got := webdav.Lists["addr"].Values; !slices.Equal(got, []string{"127.0.0.1:9999", "[::1]:8,0"}) {
		t.Errorf("webdav addr elements %q", got)
	}
}

// rcloneAsks runs rclone's own config for a new remote of type ri with the given provider. It
// calls fs.BackendConfig from ConfigAll, includes every advanced question, and answers each one
// with its current value. It returns the options asked, in order, and the values suggested for
// each. The backend's own Config step, which comes afterwards, is left out.
func rcloneAsks(t *testing.T, ri *fs.RegInfo, provider string) ([]string, map[string][]string) {
	t.Helper()
	r := *ri
	r.Config = nil
	m := configmap.Simple{}
	if provider != "" {
		m[fs.ConfigProvider] = provider
	}
	var asked []string
	examples := map[string][]string{}
	in := fs.ConfigIn{State: fs.ConfigAll}
	advanced := false
	for range 10000 {
		out, err := fs.BackendConfig(context.Background(), "test", m, &r, configmap.Simple{}, in)
		if err != nil {
			t.Fatalf("%s: %v", ri.Name, err)
		}
		if out == nil || out.State == "" {
			return asked, examples
		}
		if out.Option.Name == "config_fs_advanced" { // asked after each round: answer yes once
			in = fs.ConfigIn{State: out.State, Result: fmt.Sprint(!advanced)}
			advanced = true
			continue
		}
		asked = append(asked, out.Option.Name)
		for _, ex := range out.Option.Examples {
			if !slices.Contains(examples[out.Option.Name], ex.Value) {
				examples[out.Option.Name] = append(examples[out.Option.Name], ex.Value)
			}
		}
		current, _ := m.Get(out.Option.Name)
		in = fs.ConfigIn{State: out.State, Result: current}
	}
	t.Fatalf("%s: rclone's config did not end", ri.Name)
	return nil, nil
}

// A backend's view for a provider matches what rclone's config asks for it. It has the same
// options, apart from those that rclone hides from its config, which the catalog also marks.
// Each option's choices start with the values rclone suggests. This is checked for every
// provider of every backend that has providers.
func TestBackendIsWhatRcloneAsks(t *testing.T) {
	s := New("")
	compared := 0
	defer func() {
		if compared < 40 { // s3 alone has more providers
			t.Errorf("only %d providers compared", compared)
		}
	}()
	for _, ri := range fs.Registry {
		po := ri.Options.Get(fs.ConfigProvider)
		if po == nil {
			continue
		}
		providers := []string{""}
		for _, ex := range po.Examples {
			providers = append(providers, ex.Value)
		}
		for _, provider := range providers {
			view, err := s.Backend(ri.Name, provider)
			if err != nil {
				t.Fatal(err)
			}
			if provider == "" && view.Provider != defaultText(po) {
				t.Errorf("%s: no provider is %q, want the default %q", ri.Name, view.Provider, defaultText(po))
			}
			if view.Provider == "" {
				continue // no provider yet: see TestBackendWaitsForAProvider
			}
			compared++
			asked, examples := rcloneAsks(t, ri, view.Provider)
			var shown []string
			for _, o := range view.Backend.Options {
				if ri.Options.Get(o.Name).Hide&fs.OptionHideConfigurator == 0 {
					shown = append(shown, o.Name)
				}
				if want := examples[o.Name]; o.Kind != KindChoice && o.Kind != KindFlags &&
					(len(o.Choices) < len(want) || !slices.Equal(values(o.Choices)[:len(want)], want)) {
					t.Errorf("%s for %s: %s offers %v, rclone %v", ri.Name, view.Provider, o.Name, values(o.Choices), want)
				}
			}
			slices.Sort(shown)
			slices.Sort(asked)
			if !slices.Equal(shown, asked) {
				t.Errorf("%s for %s: options\n %v\nrclone asks\n %v", ri.Name, view.Provider, shown, asked)
			}
		}
	}
}

// With no provider chosen and no default, a backend's view has the options that apply to every
// provider, with their suggestions unfiltered, as rclone shows them without a provider.
func TestBackendWaitsForAProvider(t *testing.T) {
	s := New("")
	view, err := s.Backend("s3", "")
	if err != nil || view.Provider != "" {
		t.Fatalf("%+v %v", view, err)
	}
	ri, _ := fs.Find("s3")
	var want []string
	for _, o := range ri.Options {
		if o.Provider == "" {
			want = append(want, o.Name)
		}
	}
	var got []string
	for _, o := range view.Backend.Options {
		got = append(got, o.Name)
	}
	if !slices.Equal(got, want) || !slices.Contains(got, "provider") || slices.Contains(got, "region") {
		t.Errorf("options %v, want %v", got, want)
	}
	// A provider's view offers only that provider's regions.
	aws, _ := s.Backend("s3", "AWS")
	region := values(option(t, aws.Backend.Options, "region").Choices)
	if !slices.Contains(region, "eu-west-1") || slices.Contains(region, "de") {
		t.Errorf("AWS regions %v", region)
	}
	// A backend without providers has all its options, and every registered name, aliases
	// included, finds its own backend.
	drive, _ := s.Backend("drive", "")
	if len(drive.Backend.Options) != len(backend(t, s.Catalog(), "drive").Options) {
		t.Errorf("drive has %d options", len(drive.Backend.Options))
	}
	for _, ri := range fs.Registry {
		if b, err := s.Backend(ri.Name, ""); err != nil || b.Backend.Name != ri.Name {
			t.Errorf("%s: %v %v", ri.Name, b.Backend.Name, err)
		}
	}
	if _, err := s.Backend("gopher", ""); errs.Of(err) == nil || errs.Of(err).Code != errs.CodeNotFound {
		t.Errorf("an unknown backend: %v", err)
	}
}

func TestSummaryLeavesOptionsOut(t *testing.T) {
	s := New("")
	sum, cat := s.Summary(), s.Catalog()
	for _, b := range sum.Backends {
		if len(b.Options) > 0 {
			t.Errorf("Summary's %s has %d options", b.Name, len(b.Options))
		}
	}
	// The metadata mapper reads a local path's fields from the metadata info, so the summary
	// keeps it.
	if backend(t, sum, "local").MetadataInfo == nil {
		t.Error("Summary's local lost its metadata info")
	}
	if len(backend(t, cat, "s3").Options) == 0 {
		t.Error("Catalog's s3 lost its options")
	}
	size := func(c *Catalog) int {
		b, _ := json.Marshal(c)
		return len(b)
	}
	if got, all := size(sum), size(cat); got*3 >= all {
		t.Errorf("Summary is %d bytes of Catalog's %d, want under a third", got, all)
	}
}

// The remote option of each wrapping backend is marked for the remote picker, and only that
// option. A backend that rclone adds later with a "remote" option fails here until it is listed.
func TestWrappedRemotes(t *testing.T) {
	for typ, opt := range wrappedRemotes {
		ri, err := fs.Find(typ)
		if err != nil {
			t.Errorf("rclone has no backend %s", typ)
			continue
		}
		if ri.Options.Get(opt) == nil {
			t.Errorf("%s has no option %s", typ, opt)
		}
	}
	for _, ri := range fs.Registry {
		if ri.Options.Get("remote") != nil && wrappedRemotes[ri.Name] != "remote" {
			t.Errorf("%s has a remote option that is not marked", ri.Name)
		}
	}
	s := New("")
	for _, typ := range []string{"alias", "crypt"} {
		b, err := s.Backend(typ, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range b.Backend.Options {
			if want := o.Name == "remote"; (o.Path == PathRemote) != want {
				t.Errorf("%s.%s path = %q", typ, o.Name, o.Path)
			}
		}
	}
	cache, err := s.Backend("cache", "")
	if err != nil {
		t.Fatal(err)
	}
	if p := option(t, cache.Backend.Options, "tmp_upload_path").Path; p != PathDir {
		t.Errorf("cache tmp_upload_path path = %q, want a folder", p)
	}
	s3, err := s.Backend("s3", "AWS")
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range s3.Backend.Options {
		if o.Path == PathRemote {
			t.Errorf("s3.%s is marked as a wrapped remote", o.Name)
		}
	}
}
