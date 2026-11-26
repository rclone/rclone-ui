package operations

import (
	"encoding/csv"
	"encoding/json"
	"maps"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

type ServeEnv struct {
	Exe string
}

type Serve struct {
	Args []string
	Env  []string
	// The child's log lines must not show these, because rclone prints each one as it reads it
	// at DEBUG level.
	Secrets []string
	Source  string
	Addr    string
	Addrs   []string
	own     []blockGroup
	groups  Groups
}

func ServeCommand(a ServeArgs, env ServeEnv) (Serve, error) {
	a.Options = withDefaults(OperationServe, a.Options)
	if a.Source == "" || a.Type == "" {
		return Serve{}, errs.New("Please select both a source and serve type")
	}
	// rclone's list depends on the build. For example, nfs is not built on Windows.
	if !slices.Contains(rclone.ServeTypes(), a.Type) || !hasBlock(a.Type) {
		return Serve{}, errs.Errorf("Serving over %s isn't available on this computer", a.Type)
	}
	if err := location.Refusal(a.Source); err != nil {
		return Serve{}, err
	}
	remotes, err := a.Options.remotes()
	if err != nil {
		return Serve{}, err
	}
	src := split(a.Source)
	source, err := fsString(src, src.Dir(), remotes[src.Name])
	if err != nil {
		return Serve{}, err
	}
	serveOptions, err := decodeGroup(GroupServe, a.Options.Serve)
	if err != nil {
		return Serve{}, err
	}
	vfsOptions, err := decodeGroup(GroupVFS, a.Options.VFS)
	if err != nil {
		return Serve{}, err
	}
	addr := a.Addr
	addrs := []string{addr}
	if addr != "" {
		serveOptions["addr"] = addr
	} else {
		addr = firstAddr(serveOptions, a.Type)
		addrs = allAddrs(serveOptions, a.Type)
	}
	serveBlocks := []string{a.Type, "proxy"}
	own := []blockGroup{
		{GroupServe, serveOptions, serveBlocks},
		{GroupVFS, vfsOptions, []string{GroupVFS}},
	}
	flags, err := commandFlags(a.Options, env.Exe, own...)
	if err != nil {
		return Serve{}, err
	}
	flags, secretVars, secrets, err := secretEnv(flags, serveBlocks)
	if err != nil {
		return Serve{}, err
	}
	return Serve{
		Args:    append([]string{"serve", a.Type, source}, flags...),
		Env:     secretVars,
		Secrets: secrets,
		Source:  source,
		Addr:    addr,
		Addrs:   addrs,
		own:     own,
		groups:  a.Options,
	}, nil
}

// rclone doesn't mark either one as Sensitive. A flag would appear on the child's command line,
// which any local user can read (ps, /proc/<pid>/cmdline), and in children.json.
var secretOptions = []string{"pass", "auth_key"}

// rclone reads every flag's value from RCLONE_<FLAG> when it adds the flag (installFlag in
// fs/config/flags). It reads a list option from a single CSV record (fs.CommaSepList), so the
// repeated flags of a list become one variable.
func secretEnv(flags, blocks []string) (rest, env, values []string, err error) {
	rest = flags
	for _, name := range secretOptions {
		var option *fs.Option
		for _, b := range blocks {
			if found, ok := blockOption(b, name); ok {
				option = found
				break
			}
		}
		if option == nil {
			continue
		}
		prefix := "--" + flagName(option) + "="
		var given []string
		rest = slices.DeleteFunc(rest, func(arg string) bool {
			v, ok := strings.CutPrefix(arg, prefix)
			if ok {
				given = append(given, v)
			}
			return ok
		})
		if len(given) == 0 {
			continue
		}
		value := given[0]
		if _, list := option.Default.([]string); list {
			var b strings.Builder
			w := csv.NewWriter(&b)
			if err := w.Write(given); err != nil {
				return nil, nil, nil, err
			}
			w.Flush()
			value = strings.TrimSuffix(b.String(), "\n")
			values = append(values, given...)
		}
		env = append(env, fs.OptionToEnv(flagName(option))+"="+value)
		values = append(values, value)
	}
	return rest, env, values, nil
}

func ServeSecrets(a ServeArgs) (kept ServeArgs, secrets json.RawMessage, err error) {
	group := maps.Clone(a.Options.Serve)
	taken := catalog.Group{}
	for key, raw := range group {
		if !slices.Contains(secretOptions, catalog.NormalizeOptionName(key)) {
			continue
		}
		var v any
		if err := decodeJSON(raw, &v); err == nil && isBlank(v) {
			continue
		}
		taken[key] = raw
		delete(group, key)
	}
	if len(taken) == 0 {
		return a, nil, nil
	}
	if secrets, err = json.Marshal(taken); err != nil {
		return ServeArgs{}, nil, err
	}
	a.Options.Serve = group
	return a, secrets, nil
}

func WithServeSecrets(a ServeArgs, secrets json.RawMessage) (ServeArgs, error) {
	var taken catalog.Group
	if err := decodeJSON(secrets, &taken); err != nil {
		return ServeArgs{}, err
	}
	if len(taken) == 0 {
		return a, nil
	}
	group := maps.Clone(a.Options.Serve)
	if group == nil {
		group = catalog.Group{}
	}
	maps.Copy(group, taken)
	a.Options.Serve = group
	return a, nil
}

func allAddrs(o options, serveType string) []string {
	switch v := o["addr"].(type) {
	case string:
		if v != "" {
			return []string{v}
		}
	case []any:
		var addrs []string
		for _, e := range v {
			if text, err := elementText(e); err == nil && text != "" {
				addrs = append(addrs, text)
			}
		}
		if len(addrs) > 0 {
			return addrs
		}
	}
	if first := firstAddr(o, serveType); first != "" {
		return []string{first}
	}
	return nil
}

func firstAddr(o options, serveType string) string {
	switch v := o["addr"].(type) {
	case string:
		if v != "" {
			return v
		}
	case []any:
		if len(v) > 0 {
			if first, err := elementText(v[0]); err == nil {
				return first
			}
		}
	}
	if option, ok := blockOption(serveType, "addr"); ok {
		switch d := option.Default.(type) {
		case string:
			return d
		case []string:
			if len(d) > 0 {
				return d[0]
			}
		}
	}
	return ""
}
