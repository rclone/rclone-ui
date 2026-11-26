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

type Service struct {
	once    sync.Once
	cat     *Catalog
	summary *Catalog
	exe     string
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

// Summary returns the catalog with the backends but without their options. Callers must not
// change it.
func (s *Service) Summary() *Catalog {
	s.load()
	return s.summary
}

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

	raw, _ := json.Marshal(out)
	sum := sha256.Sum256(raw)
	out.Version = version.Rclone() + "-" + hex.EncodeToString(sum[:6])
	return out
}

func backendOf(ri *fs.RegInfo, options []fs.Option, t *texts) Backend {
	prefix := backendPrefix(ri.Name)
	b := Backend{
		Name:         ri.Name,
		Description:  t.text(key(prefix, "description"), ri.Description),
		Prefix:       ri.Prefix,
		Aliases:      slices.Clone(ri.Aliases),
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
// rclone's config asks for when the remote has the given provider. An option or an example is
// kept when its provider filter matches the provider. An empty provider means the provider
// option's default. When that is empty too, no provider is chosen yet: the result has only the
// options that apply to every provider, with all their examples. The text is rclone's English.
func (s *Service) Backend(typ, provider string) (*BackendOptions, error) {
	return s.backend(typ, provider, nil)
}

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
			continue
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

var namePresets = map[string][]string{
	"order_by": {
		"name,ascending", "name,descending",
		"size,ascending", "size,descending",
		"modtime,ascending", "modtime,descending",
	},
}

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
	"service_account_file":    PathFile,
	"box_config_file":         PathFile,
	"client_certificate_path": PathFile,
	"service_principal_file":  PathFile,
	"config_file":             PathFile,
	"sse_customer_key_file":   PathFile,
	"shared_credentials_file": PathFile,
	"key_file":                PathFile,
	"known_hosts_file":        PathFile,
	"pubkey_file":             PathFile,
	"kerberos_ccache":         PathFile,
	"unix_socket":             PathFile,
	"chunk_path":              PathDir,
	"db_path":                 PathDir,
	"tmp_upload_path":         PathDir,
}

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

var blockOptions = sync.OnceValue(func() map[string][]Option { return convertBlocks(nil) })

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

var sections = sync.OnceValue(func() []Section { return groups(blockOptions()) })

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
		pick("metadata", []string{"main", "filter"}, func(o *Option) bool { return in(o, "Metadata") }),
	}
	for _, t := range rclone.ServeTypes() {
		// A serve's block is registered only when the serve is built in.
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
