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

// ServeEnv holds what a serve's command line needs in addition to the page's form.
type ServeEnv struct {
	Exe string // the running executable, for the app's own metadata mapper
}

// Serve is the command line of a serve child, and the details that the parent keeps about it.
type Serve struct {
	// Args come after the child entry: `serve <type> <fs> --flag=value…`. The parent adds the
	// flags that every child gets.
	Args []string
	// Env holds the serve's credentials (secretOptions) as variables such as `RCLONE_PASS=…`.
	// They go in the child's environment and never on its command line. children.json doesn't
	// store them either, because they are removed from the form that it records (ServeSecrets).
	Env []string
	// Secrets holds the values in Env, which the child's log lines must not show, because rclone
	// prints each one as it reads it at DEBUG level. For a list, each item is included as well
	// as the whole CSV record.
	Secrets []string
	Source  string
	// Addr is the address that the serve listens on: the form's address, or else rclone's
	// default for the type. The parent resolves a port 0 before the child starts, and sets Addr
	// in the args.
	Addr string
	// Addrs holds every address that the serve listens on, Addr first.
	Addrs []string
	// own holds the serve and vfs groups that Args were made from, credentials included, and
	// groups holds the form's groups with the app's defaults, for a program's serve (sdkServe).
	own    []blockGroup
	groups Groups
}

// ServeCommand builds a serve's command line. The serve group (with the options of the serve
// type and of the auth proxy) and the vfs group become flags directly. The other groups are
// handled as for a mount, and the app's defaults go under them as well (withDefaults).
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
	// As for a mount, only the syntax is checked, because the child reads its own config file.
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

// secretOptions lists the serve options whose values are credentials. rclone doesn't mark
// either one as Sensitive. A flag would appear on the child's command line, which any local user
// can read (ps, /proc/<pid>/cmdline), and in children.json.
var secretOptions = []string{"pass", "auth_key"}

// secretEnv moves the flags of the secret options out of flags and into variables for the
// child's environment. rclone reads every flag's value from RCLONE_<FLAG> when it adds the flag
// (installFlag in fs/config/flags). It reads a list option from a single CSV record
// (fs.CommaSepList), so the repeated flags of a list become one variable. values holds what the
// variables contain: each flag's value, and for a list, the CSV record too.
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

// ServeSecrets removes the credentials (secretOptions) from the serve group of a. kept is a
// without them, which may be written to disk to start the serve again. secrets holds only the
// credentials, as a serve group of their own, or nil when a has none. Each option keeps the name
// the page used, so WithServeSecrets returns the same form.
func ServeSecrets(a ServeArgs) (kept ServeArgs, secrets json.RawMessage, err error) {
	group := maps.Clone(a.Options.Serve)
	taken := catalog.Group{}
	for key, raw := range group {
		if !slices.Contains(secretOptions, catalog.NormalizeOptionName(key)) {
			continue
		}
		var v any
		if err := decodeJSON(raw, &v); err == nil && isBlank(v) {
			continue // a blank value has nothing to hide
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

// WithServeSecrets puts the credentials that ServeSecrets removed from a form back into its
// serve group.
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

// allAddrs returns every address that a serve listens on: the ones in the group, or else the
// default for the serve type.
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

// firstAddr returns the first address that a serve listens on: the one in the group, or else the
// default for the serve type.
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
