package catalog

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/spf13/pflag"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/metadatamap"
	"github.com/rclone/rclone-ui/core/rclone"
)

// The reasons why a flag from a pasted command, or an option of a template, was not put into any
// group. A page shows them next to the flag, in the app's language (LocalSkipped).
var (
	reasonUnknown = i18n.M("Rclone has no such flag.")
	// i18n: The flag is one of a storage backend's options, such as --drive-chunk-size.
	reasonBackend = i18n.M("A backend's option: set it on the remote.")
	// i18n: The flag is one of the app's settings, such as --bwlimit, which applies to every run.
	reasonSettings = i18n.M("Applies to the whole app, not to a single operation.")
	reasonNoGroup  = i18n.M("No page sets this option.")
	reasonCLI      = i18n.M("Only rclone's command line reads it.")
)

// ErrCommand is the start of the error for a command line that can't be read, such as one with an
// unclosed quote or a flag without its value. ParseCommand refuses such a line on the command
// field, with a message that starts with ErrCommand's.
var ErrCommand = errors.New("The command line cannot be read")

var errUnclosed = fmt.Errorf("%w: a quote is not closed.", ErrCommand)

// flagOf records what one flag in the temporary flag set stands for: an option of a block, or
// an option of a backend, whose flags carry the backend's prefix.
type flagOf struct {
	block   string
	backend bool
	opt     *fs.Option
}

// ParseCommand reads a pasted command line with rclone's own flag definitions. Each flag's value
// is a copy of its option (fs.Option is a pflag.Value), in a flag set made for this call, so
// neither rclone's global flags nor its config are affected. The options that the command sets
// are sorted into the catalog's groups (SortOptions). Flags that no group takes are skipped, with
// the reason. A line that can't be read is refused on the command field.
//
// When metadata_mapper runs the app's own mapper, the executable path that the Copy command put
// in front of it is removed. The value is then what the mapping panel writes
// (`["metadata-map", …]`), so it works whichever binary the app runs as later.
func (s *Service) ParseCommand(line string) (*ParsedCommand, error) {
	words, err := splitCommand(line)
	if err != nil {
		// splitCommand fails only on a quote that isn't closed (errUnclosed).
		return nil, errs.Field("command", "The command line cannot be read: a quote is not closed.")
	}
	if len(words) > 0 && isRclone(words[0]) {
		words = words[1:]
	}
	serve := serveType(words)
	set, flags := flagSet(serve)
	out := &ParsedCommand{}
	for _, name := range unknownFlags(set, words) {
		out.Skipped = append(out.Skipped, Skip(name, reasonUnknown))
	}
	var order []string             // the flags that were set, in the order they first appear
	written := map[string]string{} // the last text given for each flag
	err = set.ParseAll(words, func(f *pflag.Flag, value string) error {
		if err := f.Value.Set(value); err != nil {
			// rclone's own reason, such as an invalid size, keeps rclone's words.
			out.Skipped = append(out.Skipped, SkippedFlag{Flag: "--" + f.Name, Reason: err.Error()})
			return nil
		}
		if !slices.Contains(order, f.Name) {
			order = append(order, f.Name)
		}
		written[f.Name] = value
		return nil
	})
	if err != nil {
		// i18n: The value is pflag's English reason, such as "flag needs an argument: --transfers".
		return nil, errs.Field("command", "The command line cannot be read: %s.", err)
	}
	out.Args = set.Args()

	// The options of the blocks that the pages set are sorted into groups by SortOptions. A
	// serve's own block counts only in that serve's command, because rclone's other commands
	// have no such flags.
	flat := Group{}
	flagOf := map[string]string{} // the flag of each option in flat
	reasons := map[string]i18n.Text{}
	for _, name := range order {
		fo, known := flags[name]
		switch {
		case known && !fo.opt.IsSet():
			continue // every value given for it was refused
		case !known: // one of cliOnly
			reasons[name] = reasonCLI
		case fo.backend:
			reasons[name] = reasonBackend
		case !pageBlock(fo.block, serve):
			reasons[name] = reasonNoGroup
		default:
			value := pageValue(fo.opt, written[name])
			if argv, ok := value.([]string); ok && fo.opt.Name == "metadata_mapper" {
				if own, ok := metadatamap.Own(argv, s.exe); ok {
					value = own
				}
			}
			flat[fo.opt.Name] = marshal(value)
			flagOf[fo.opt.Name] = name
		}
	}
	sorted := SortOptions(flat, serve)
	for _, skip := range sorted.Skipped {
		reasons[flagOf[skip.Flag]] = skip.text
	}
	for _, name := range order {
		if reason, ok := reasons[name]; ok {
			out.Skipped = append(out.Skipped, Skip("--"+name, reason))
		}
	}
	out.Groups = sorted.Groups
	return out, nil
}

// pageBlock reports whether the pages take a block's options from a command. They take the
// global blocks and the mount block, and a serve's own block only from that serve's command.
func pageBlock(block, serve string) bool {
	switch block {
	case "main", "filter", "vfs", "mount":
		return true
	}
	return block == serve && serve != ""
}

// flagSet defines every rclone option as a flag. Each flag is a copy of the option, named as
// rclone names its flag (fs.Option.FlagName). The blocks that the pages set come first (main,
// filter, vfs, mount, and the serve's own block when the command is a serve). They are added
// without a prefix, as rclone adds them (flags.AddFlagsFromOptions sets NoPrefix). Then come the
// other blocks, and the backends' options with their prefix, so that their flags are recognized
// and their values aren't mistaken for paths. When a name or a shorthand is already defined, the
// first definition wins, because rclone's own command line has one flag per name.
func flagSet(serve string) (*pflag.FlagSet, map[string]flagOf) {
	set := pflag.NewFlagSet("rclone", pflag.ContinueOnError)
	set.SetOutput(discard{})
	set.ParseErrorsAllowlist.UnknownFlags = true
	flags := map[string]flagOf{}
	add := func(prefix, block string, backend bool, o *fs.Option) {
		c := o.Copy()
		c.Value = nil
		c.MarkUnset()
		if prefix == "" {
			c.NoPrefix = true
		}
		name := c.FlagName(prefix)
		if set.Lookup(name) != nil {
			return
		}
		short := c.ShortOpt
		if short != "" && set.ShorthandLookup(short) != nil {
			short = ""
		}
		f := set.VarPF(c, name, short, "")
		if _, isBool := c.Default.(bool); isBool {
			f.NoOptDefVal = "true"
		}
		flags[name] = flagOf{block: block, backend: backend, opt: c}
	}
	blocks := []string{"main", "filter", "vfs", "mount"}
	if serve != "" {
		blocks = append(blocks, serve)
	}
	var rest []string
	for name := range fs.OptionsRegistry {
		if !slices.Contains(blocks, name) {
			rest = append(rest, name)
		}
	}
	slices.Sort(rest)
	for _, block := range append(blocks, rest...) {
		oi, ok := fs.OptionsRegistry[block]
		if !ok {
			continue
		}
		for i := range oi.Options {
			add("", block, false, &oi.Options[i])
		}
	}
	for _, ri := range fs.Registry {
		for i := range ri.Options {
			add(ri.Prefix, ri.Name, true, &ri.Options[i])
		}
	}
	for _, c := range cliOnly {
		if set.Lookup(c.name) != nil {
			continue
		}
		short := c.short
		if short != "" && set.ShorthandLookup(short) != nil {
			short = ""
		}
		switch c.kind {
		case cliBool:
			set.BoolP(c.name, short, false, "")
		case cliCount:
			set.CountP(c.name, short, "")
		case cliString:
			set.StringP(c.name, short, "", "")
		case cliList:
			set.StringArrayP(c.name, short, nil, "")
		}
	}
	return set, flags
}

type cliKind int

const (
	cliBool cliKind = iota
	cliCount
	cliString
	cliList
)

// cliOnly lists the flags on rclone's command line that aren't options: the flags that
// configflags.AddFlags defines itself (fs/config/configflags/configflags.go:44-60), the ones of
// the command package (cmd/cmd.go:47-49), and cobra's help. rclone keeps them in package
// variables that only its CLI reads, so no page sets them. They are defined here so that their
// values aren't mistaken for paths and -h doesn't end the parse. The list is kept by hand,
// because calling rclone's AddFlags on our own flag set would change rclone's globals: it reads
// RCLONE_* into the global options, can end the process with fs.Fatalf, and sets NoPrefix on the
// registry's options. TestCLIOnlyFlags checks the list against rclone's command line.
var cliOnly = []struct {
	name, short string
	kind        cliKind
}{
	{"verbose", "v", cliCount},
	{"quiet", "q", cliBool},
	{"config", "", cliString},
	{"cache-dir", "", cliString},
	{"temp-dir", "", cliString},
	{"dump-headers", "", cliBool},
	{"dump-bodies", "", cliBool},
	{"delete-before", "", cliBool},
	{"delete-during", "", cliBool},
	{"delete-after", "", cliBool},
	{"bind", "", cliString},
	{"disable", "", cliString},
	{"header-upload", "", cliList},
	{"header-download", "", cliList},
	{"header", "", cliList},
	{"metadata-set", "", cliList},
	{"dscp", "", cliString},
	{"cpuprofile", "", cliString},
	{"memprofile", "", cliString},
	{"stats", "", cliString}, // a duration
	{"help", "h", cliBool},
}

// discard swallows pflag's usage output.
type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// pageValue returns an option's value in the form that the pages' option editors write in a
// group's JSON. A switch, a tristate or a number is a JSON value. The elements of a repeated
// flag or an argv become a list. Anything else is the last text given for the flag. rclone has
// already parsed that text, so it will parse the same way again, whereas rclone's own rendering
// would round a size of 1234567 bytes to 1.177Mi.
func pageValue(o *fs.Option, text string) any {
	switch v := o.GetValue().(type) {
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return v
	case fs.Tristate:
		if !v.Valid {
			return nil
		}
		return v.Value
	case []string:
		return append([]string{}, v...)
	case fs.SpaceSepList:
		return append([]string{}, v...)
	}
	return text
}

// serveType returns the serve type that a command starts (`serve webdav …`) when its block is
// registered in this build, and "" otherwise.
func serveType(words []string) string {
	var args []string
	for _, w := range words {
		if w == "--" {
			break
		}
		if !strings.HasPrefix(w, "-") {
			args = append(args, w)
		}
	}
	if len(args) < 2 || args[0] != "serve" || !slices.Contains(rclone.ServeTypes(), args[1]) {
		return ""
	}
	if _, ok := fs.OptionsRegistry[args[1]]; !ok {
		return ""
	}
	return args[1]
}

// isRclone reports whether a command's first word runs rclone, meaning rclone or this app, at
// any path.
func isRclone(word string) bool {
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(word, `\`, "/")))
	base = strings.TrimSuffix(base, ".exe")
	return base == "rclone" || base == "rcui"
}

// unknownFlags returns the flags in words that set doesn't define, as they were written. pflag
// has no supported way to list them. When unknown flags are allowed
// (ParseErrorsAllowlist.UnknownFlags), pflag skips each one, along with the next word if that
// isn't a flag (stripUnknownFlagValue), and calls no callback. When they are refused, the parse
// stops at the first one with a NotExistError that doesn't say which. So this function walks the
// words using pflag's own grammar (parseArgs, parseLongArg and parseSingleShortArg in pflag
// v1.0.10).
func unknownFlags(set *pflag.FlagSet, words []string) []string {
	var out []string
	for i := 0; i < len(words); i++ {
		w := words[i]
		switch {
		case w == "--":
			return out
		case strings.HasPrefix(w, "--"):
			name, _, hasValue := strings.Cut(w[2:], "=")
			f := set.Lookup(name)
			switch {
			case f == nil:
				out = append(out, "--"+name)
			case !hasValue && f.NoOptDefVal == "":
				i++ // the next word is its value
			}
		case strings.HasPrefix(w, "-") && len(w) > 1:
			shorts := w[1:]
			for j := 0; j < len(shorts); j++ {
				if shorts[j] == '=' {
					break
				}
				f := set.ShorthandLookup(shorts[j : j+1])
				if f == nil {
					out = append(out, "-"+shorts[j:j+1])
					continue
				}
				if f.NoOptDefVal == "" {
					if j == len(shorts)-1 {
						i++ // the next word is its value
					}
					break // the rest of the word is its value
				}
			}
		}
	}
	return out
}

// splitCommand splits a pasted line into words as a POSIX shell does. Blanks separate words.
// Single quotes keep everything inside them as is. Double quotes keep everything except a
// backslash before " \ $ or `, which is dropped. Outside quotes, a backslash escapes the
// character after it. The exception is a backslash before a letter, a digit, a dot or an
// underscore, which is kept, so that a Windows path (C:\Users\me) works without quotes. A
// backslash at the end of a line joins it to the next line.
func splitCommand(line string) ([]string, error) {
	var (
		words []string
		cur   strings.Builder
		in    bool // a word has started (a pair of quotes starts an empty one)
	)
	flush := func() {
		if in {
			words = append(words, cur.String())
			cur.Reset()
			in = false
		}
	}
	r := []rune(line)
	for i := 0; i < len(r); i++ {
		c := r[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			flush()
		case c == '\'':
			in = true
			j := i + 1
			for j < len(r) && r[j] != '\'' {
				j++
			}
			if j == len(r) {
				return nil, errUnclosed
			}
			cur.WriteString(string(r[i+1 : j]))
			i = j
		case c == '"':
			in = true
			j := i + 1
			for ; j < len(r) && r[j] != '"'; j++ {
				if r[j] == '\\' && j+1 < len(r) && strings.ContainsRune("\"\\$`", r[j+1]) {
					j++
				} else if r[j] == '\\' && j+1 < len(r) && r[j+1] == '\n' {
					j++
					continue
				}
				cur.WriteRune(r[j])
			}
			if j == len(r) {
				return nil, errUnclosed
			}
			i = j
		case c == '\\' && i+1 < len(r):
			next := r[i+1]
			switch {
			case next == '\n':
				i++ // a continued line
			case next == '\r' && i+2 < len(r) && r[i+2] == '\n':
				i += 2
			case isWordRune(next):
				in = true
				cur.WriteRune(c) // a path's separator
			default:
				in = true
				cur.WriteRune(next)
				i++
			}
		default:
			in = true
			cur.WriteRune(c)
		}
	}
	flush()
	return words, nil
}

func isWordRune(c rune) bool {
	return c == '.' || c == '_' || '0' <= c && c <= '9' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}
