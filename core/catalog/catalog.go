// Package catalog provides rclone's reference data for the pages: the backends and their
// options, the global option blocks, and the option groups that the pages offer. Each option
// carries its kind, so that no page has to work out from a Go type name what a value is.
package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/lib/encoder"
	"github.com/rclone/rclone/vfs/vfscommon"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/version"
)

// Service builds the catalog once, because rclone's registry doesn't change while the process
// runs.
type Service struct {
	once    sync.Once
	cat     *Catalog
	summary *Catalog
	// exe is the running executable, which a pasted Copy command puts in front of the app's own
	// metadata mapper. ParseCommand removes it.
	exe string
}

func New(exe string) *Service { return &Service{exe: exe} }

func (s *Service) load() {
	s.once.Do(func() {
		s.cat = build()
		s.summary = summarize(s.cat)
	})
}

// Catalog returns the whole catalog, with every backend and its options. Callers must not
// change it.
func (s *Service) Catalog() *Catalog {
	s.load()
	return s.cat
}

// Summary returns the catalog that API.Get sends, with the backends but without their options.
// The options make up four fifths of the catalog's size, and the pages request them through
// Backend, one backend and provider at a time. Callers must not change it.
func (s *Service) Summary() *Catalog {
	s.load()
	return s.summary
}

// summarize returns a copy of cat without the backends' options.
func summarize(cat *Catalog) *Catalog {
	out := *cat
	out.Backends = make([]Backend, len(cat.Backends))
	for i, b := range cat.Backends {
		b.Options = nil
		out.Backends[i] = b
	}
	return &out
}

// Values returns the global options that differ from rclone's defaults, without secrets. They
// are grouped by block and keyed by rclone's option name. Each value is written as rclone writes
// it, in the same form as default_text ("5m0s", not 300000000000). List options also come as
// their separate elements.
func (s *Service) Values(ctx context.Context) *Values {
	out := &Values{Blocks: map[string]*BlockValues{}}
	for block, text := range rclone.OptionValues(ctx) {
		out.Blocks[block] = &BlockValues{Text: text, Lists: lists(block, text)}
	}
	return out
}

// lists returns the elements of the list options among a block's values, where text maps option
// names to their text. The elements are read from rclone's value itself (a []string,
// fs.CommaSepList or fs.SpaceSepList), because a list's text is a CSV record or an argv, and only
// rclone's parser splits it exactly.
func lists(block string, text map[string]string) map[string]*List {
	oi, ok := fs.OptionsRegistry[block]
	if !ok || oi.Opt == nil {
		return nil
	}
	items, err := configstruct.Items(oi.Opt)
	if err != nil {
		return nil
	}
	var out map[string]*List
	for _, it := range items {
		if _, ok := text[it.Name]; !ok {
			continue
		}
		v := reflect.ValueOf(it.Value)
		if !v.IsValid() || !rclone.IsListType(v.Type()) {
			continue
		}
		if out == nil {
			out = map[string]*List{}
		}
		out[it.Name] = &List{Values: slices.Clone(v.Convert(reflect.TypeFor[[]string]()).Interface().([]string))}
	}
	return out
}

func build() *Catalog {
	out := &Catalog{}
	for _, ri := range fs.Registry {
		out.Backends = append(out.Backends, backendOf(ri, ri.Options, nil))
	}
	sort.Slice(out.Backends, func(i, j int) bool { return out.Backends[i].Name < out.Backends[j].Name })

	blocks := blockOptions()
	for _, name := range slices.Sorted(maps.Keys(blocks)) {
		out.Blocks = append(out.Blocks, Block{Name: name, Options: blocks[name]})
	}
	out.Groups = sections()
	out.Defaults = Defaults()

	// The version identifies the content. It is rclone's version plus a hash, which covers a
	// build that changed an option without a new version number, such as a development build.
	raw, _ := json.Marshal(out) // plain fields and sorted maps, so it can't fail and is stable
	sum := sha256.Sum256(raw)
	out.Version = version.Rclone() + "-" + hex.EncodeToString(sum[:6])
	return out
}

// backendOf describes one of rclone's backends with the given options, which are either all of
// its own or those that apply to one provider. Its text is in t's language, or in English when t
// is nil.
func backendOf(ri *fs.RegInfo, options []fs.Option, t *texts) Backend {
	prefix := backendPrefix(ri.Name)
	b := Backend{
		Name:        ri.Name,
		Description: t.text(key(prefix, "description"), ri.Description),
		Prefix:      ri.Prefix,
		Aliases:     slices.Clone(ri.Aliases),
		// fs.Register itself hides an alias, such as tardigrade for storj.
		Hidden:       ri.Hide,
		MetadataInfo: t.metadataInfo(ri.Name, ri.MetadataInfo),
	}
	for i := range options {
		local := t.option(prefix, options[i])
		o := convert(&local)
		o.PerOperation = true
		o.Path = backendPath(ri.Name, o.Name)
		b.Options = append(b.Options, *o)
	}
	return b
}

// Backend returns the backend typ (a remote's type, looked up with fs.Find) with the options that
// rclone's config asks for when the remote has the given provider (configAll in
// fs/backend_config.go). An option or an example is kept when its provider filter matches the
// provider (fs.MatchProvider). An empty provider means the provider option's default. When that
// is empty too, no provider is chosen yet: the result has only the options that apply to every
// provider, with all their examples. The text is rclone's English (BackendIn gives it in another
// language).
func (s *Service) Backend(typ, provider string) (*BackendOptions, error) {
	return s.backend(typ, provider, nil)
}

// backend is Backend, with its text in t's language, or in English when t is nil.
func (s *Service) backend(typ, provider string, t *texts) (*BackendOptions, error) {
	ri, err := fs.Find(typ)
	if err != nil {
		return nil, errs.NotFound("backend", "Rclone has no such backend: %s", typ)
	}
	providerOption := ri.Options.Get(fs.ConfigProvider)
	if provider == "" && providerOption != nil {
		provider = defaultText(providerOption)
	}
	var options []fs.Option
	for _, o := range ri.Options {
		if provider == "" && providerOption != nil && o.Provider != "" {
			continue // asked only once a provider is chosen
		}
		if !fs.MatchProvider(o.Provider, provider) {
			continue
		}
		if provider != "" && len(o.Examples) > 0 {
			examples := fs.OptionExamples{}
			for _, ex := range o.Examples {
				if fs.MatchProvider(ex.Provider, provider) {
					examples = append(examples, ex)
				}
			}
			o.Examples = examples
		}
		options = append(options, o)
	}
	return &BackendOptions{Backend: backendOf(ri, options, t), Provider: provider}, nil
}

// FromOption describes one of rclone's options the way the catalog does, with its kind, its
// default as text, and its choices. It is also used for a config session's question (the Option
// in fs.ConfigOut).
func FromOption(o *fs.Option) *Option { return convert(o) }

func convert(o *fs.Option) *Option {
	out := &Option{
		Name:        o.Name,
		Help:        o.Help,
		Groups:      o.Groups,
		Type:        o.Type(),
		DefaultText: defaultText(o),
		Required:    o.Required,
		Advanced:    o.Advanced,
		Password:    o.IsPassword,
		Sensitive:   o.Sensitive,
		Hidden:      o.Hide != 0,
		Exclusive:   o.Exclusive,
	}
	if b, err := json.Marshal(o.Default); err == nil {
		out.Default = b
	}
	out.Kind, out.Choices, out.Separator = kindOf(o.GetValue())

	// rclone's examples add help to the values of a closed set, and act as suggestions for any
	// other option.
	if len(o.Examples) > 0 {
		if out.Kind == KindChoice || out.Kind == KindFlags {
			for i := range out.Choices {
				c := &out.Choices[i]
				for _, ex := range o.Examples {
					if strings.EqualFold(ex.Value, c.Value) && c.Help == "" {
						c.Help = ex.Help
					}
				}
			}
		} else {
			var ex []Choice
			for _, e := range o.Examples {
				ex = append(ex, Choice{Value: e.Value, Help: e.Help})
			}
			out.Choices = append(ex, out.Choices...)
		}
	}
	if out.Kind != KindChoice && out.Kind != KindFlags {
		for _, v := range namePresets[o.Name] {
			out.Choices = append(out.Choices, Choice{Value: v})
		}
		out.Choices = unique(out.Choices)
	}
	if out.Kind == KindText && len(out.Choices) == 0 {
		out.Exclusive = false
	}
	return out
}

// defaultText returns the default in the form that rclone reads from a flag or a config file and
// writes back, using fs.Option.String, so a size keeps its unit and a list keeps its quoting. Any
// value set by a flag is ignored.
func defaultText(o *fs.Option) string {
	c := o.Copy()
	c.Value = nil
	return c.String()
}

type enumChoices interface{ Choices() []string }

type bitsChoices interface {
	Choices() []fs.BitsChoicesInfo
}

var (
	sizePresets     = []string{"0", "8M", "16M", "32M", "64M", "128M", "256M", "512M", "1G"}
	durationPresets = []string{"0s", "5s", "30s", "1m", "5m", "30m", "1h", "6h", "24h"}
	tristateChoices = []string{"unset", "true", "false"}
)

// namePresets lists common values for options whose type doesn't suggest any, keyed by name.
var namePresets = map[string][]string{
	"order_by": {
		"name,ascending", "name,descending",
		"size,ascending", "size,descending",
		"modtime,ascending", "modtime,descending",
	},
}

// kindOf returns the kind of v's type, its choices, and a list's separator. The choices are
// either the only values allowed (a closed set) or common ones.
func kindOf(v any) (Kind, []Choice, string) {
	switch x := v.(type) {
	case bool:
		return KindBool, nil, ""
	case fs.Tristate:
		return KindTristate, choices(tristateChoices), ""
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return KindInt, nil, ""
	case float32, float64:
		return KindFloat, nil, ""
	case fs.SizeSuffix:
		return KindSize, choices(sizePresets), ""
	case fs.Duration, time.Duration:
		return KindDuration, choices(durationPresets), ""
	case fs.Time:
		return KindTime, nil, ""
	case vfscommon.FileMode:
		return KindFileMode, nil, ""
	case fs.BwTimetable:
		return KindBwTimetable, nil, ""
	case fs.CommaSepList:
		return KindList, nil, ","
	case fs.SpaceSepList:
		return KindList, nil, " "
	case []string:
		return KindList, nil, ","
	case encoder.MultiEncoder:
		return KindFlags, choices(strings.Split(encoder.ValidStrings(), ", ")), ""
	case enumChoices:
		return KindChoice, choices(x.Choices()), ""
	case bitsChoices:
		var names []string
		for _, c := range x.Choices() {
			if c.Name != "" {
				names = append(names, c.Name)
			}
		}
		return KindFlags, choices(names), ""
	}
	return KindText, nil, ""
}

func choices(values []string) []Choice {
	out := make([]Choice, 0, len(values))
	for _, v := range values {
		out = append(out, Choice{Value: v})
	}
	return out
}

// unique keeps the first choice for each value. A value that several providers offer, such as
// s3's region us-east-1, becomes one choice with the help text of the first.
func unique(in []Choice) []Choice {
	seen := map[string]bool{}
	out := in[:0]
	for _, c := range in {
		if seen[c.Value] {
			continue
		}
		seen[c.Value] = true
		out = append(out, c)
	}
	return out
}

// backendPaths lists the backend options that name a local file or folder. rclone doesn't mark
// them, so they are listed here by name.
var backendPaths = map[string]Path{
	"service_account_file":    PathFile, // drive, google cloud storage
	"box_config_file":         PathFile, // box
	"client_certificate_path": PathFile, // azureblob, azurefiles
	"service_principal_file":  PathFile, // azureblob, azurefiles
	"config_file":             PathFile, // oracleobjectstorage
	"sse_customer_key_file":   PathFile, // oracleobjectstorage
	"shared_credentials_file": PathFile, // s3
	"key_file":                PathFile, // sftp
	"known_hosts_file":        PathFile, // sftp
	"pubkey_file":             PathFile, // sftp
	"kerberos_ccache":         PathFile, // smb
	"unix_socket":             PathFile, // webdav
	"chunk_path":              PathDir,  // cache
	"db_path":                 PathDir,  // cache
	"tmp_upload_path":         PathDir,  // cache
}

// wrappedRemotes lists the backend options whose value rclone opens as one path: the remote that
// the backend wraps. rclone Cloud lists the same options among those that open an Fs
// (internal/rclone/names/paths.go). cache's tmp_upload_path opens an Fs too, but it is a local
// folder (backendPaths), so it keeps the folder picker. TestWrappedRemotes checks the list
// against rclone.
var wrappedRemotes = map[string]string{
	"alias":    "remote",
	"archive":  "remote",
	"cache":    "remote",
	"chunker":  "remote",
	"compress": "remote",
	"crypt":    "remote",
	"hasher":   "remote",
}

func backendPath(backend, option string) Path {
	if wrappedRemotes[backend] == option {
		return PathRemote
	}
	return backendPaths[option]
}

// blockOptions returns the options of each of rclone's option blocks, keyed by the block's name,
// in English. rclone registers its blocks at init and never changes them, so they are read once.
// Callers must not change them.
var blockOptions = sync.OnceValue(func() map[string][]Option { return convertBlocks(nil) })

// convertBlocks describes the options of each of rclone's option blocks, keyed by the block's
// name, with their text in t's language, or in English when t is nil.
func convertBlocks(t *texts) map[string][]Option {
	blocks := map[string][]Option{}
	for name, info := range fs.OptionsRegistry {
		prefix := blockPrefix(name)
		var opts []Option
		for i := range info.Options {
			local := t.option(prefix, info.Options[i])
			o := convert(&local)
			o.PerOperation = name != "main" || rclone.PerOperation(o.Name)
			opts = append(opts, *o)
		}
		blocks[name] = opts
	}
	return blocks
}

// sections returns the sections of options that the pages offer (groups), built once. Callers
// must not change them.
var sections = sync.OnceValue(func() []Section { return groups(blockOptions()) })

// groups returns the sections of options that the pages offer. Each section picks options from
// rclone's option blocks by their group tags, sorted by name.
func groups(blocks map[string][]Option) []Section {
	in := func(o *Option, g string) bool { return strings.Contains(o.Groups, g) }
	pick := func(name string, from []string, keep func(*Option) bool) Section {
		type ref struct {
			block string
			o     *Option
		}
		var refs []ref
		for _, b := range from {
			for i := range blocks[b] {
				if o := &blocks[b][i]; keep(o) {
					refs = append(refs, ref{b, o})
				}
			}
		}
		slices.SortStableFunc(refs, func(a, b ref) int { return byName(a.o.Name, b.o.Name) })
		g := Section{Name: name}
		for _, r := range refs {
			g.Options = append(g.Options, OptionRef{Block: r.block, Name: r.o.Name})
		}
		return g
	}
	notMetadata := func(o *Option) bool { return !in(o, "Metadata") }
	out := []Section{
		pick("filter", []string{"filter"}, notMetadata),
		pick("config", []string{"main"}, func(o *Option) bool {
			return o.PerOperation &&
				(in(o, "Performance") || in(o, "Listing") || in(o, "Networking") || in(o, "Check") ||
					o.Name == "use_server_modtime")
		}),
		pick("mount", []string{"mount"}, notMetadata),
		pick("vfs", []string{"vfs"}, notMetadata),
		pick("copy", []string{"main"}, func(o *Option) bool { return in(o, "Copy") && !in(o, "Metadata") }),
		pick("sync", []string{"main"}, func(o *Option) bool {
			return (in(o, "Copy") || in(o, "Sync")) && !in(o, "Metadata")
		}),
		// Everything tagged Metadata (metadata, metadata_mapper and the metadata filter rules) has
		// its own section, and the other groups leave it out.
		pick("metadata", []string{"main", "filter"}, func(o *Option) bool { return in(o, "Metadata") }),
	}
	for _, t := range rclone.ServeTypes() {
		// Only include the serve types built for this platform (nfs is Unix only). A serve's
		// block is registered only when the serve is built in.
		if _, ok := blocks[t]; ok {
			out = append(out, pick("serve."+t, []string{t}, func(*Option) bool { return true }))
		}
	}
	return out
}

// byName orders option names ([a-z0-9_]) as localeCompare does, with the underscore before
// digits and digits before letters.
func byName(a, b string) int {
	key := func(s string) string { return strings.ReplaceAll(s, "_", "\x01") }
	return strings.Compare(key(a), key(b))
}
