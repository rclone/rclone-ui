package catalog

import (
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/rclone"
)

type Sorted struct {
	// Groups holds the options of each catalog group (filter, config, copy, serve.http…), keyed
	// by rclone's option name. A group without options is missing.
	Groups map[string]Group `json:"groups"`
	// Skipped lists the options that no group takes, each with the reason. Flag is the key as it
	// was given.
	Skipped []SkippedFlag `json:"skipped"`
}

// NormalizeOptionName converts a key written by a page to rclone's option name, so `--dry-run`,
// `dry-run` and `dry_run` all name the same option.
func NormalizeOptionName(name string) string {
	return strings.ReplaceAll(strings.TrimPrefix(name, "--"), "-", "_")
}

// SortOptions sorts options into the catalog's groups. It is the one rule for this: a pasted
// command (ParseCommand), a template applied to a page, and the template drawer all use it.
//
// Each key is read as rclone's option name, in any spelling, and the option is put under that
// name. Its block is the first one that has the name, in the order that rclone's command line
// defines their flags: main, filter, vfs, mount, and then the serve's own block. The option goes
// into the first catalog group that lists it, so an option that config and copy both list goes
// into config. serve names the serve type. When it is "", a serve option goes into the group of
// every serve type that has it, because an option such as addr belongs to each one.
//
// Some options go into no group, and are skipped with the reason. A main option that a run can
// set, but no group lists (dry_run, max_depth), goes into config. The exceptions are the logging
// options, which only rclone's command line reads. A main option that rclone sets once for the
// whole app (rclone.NotPerOperation) is skipped as one of the app's settings. A name that none of
// these blocks has is skipped too, whether another block has it or rclone has no such option.
func SortOptions(options Group, serve string) Sorted {
	out := Sorted{Groups: map[string]Group{}}
	for _, key := range slices.Sorted(maps.Keys(options)) {
		name := NormalizeOptionName(key)
		into, reason := groupsOf(name, serve)
		if !reason.IsZero() {
			out.Skipped = append(out.Skipped, Skip(key, reason))
			continue
		}
		for _, group := range into {
			if out.Groups[group] == nil {
				out.Groups[group] = Group{}
			}
			out.Groups[group][name] = options[key]
		}
	}
	return out
}

// groupsOf returns the catalog groups that take the option called name, or the reason why none
// does. serve is as in SortOptions.
func groupsOf(name, serve string) ([]string, i18n.Text) {
	index := sectionIndex()
	for _, block := range []string{"main", "filter", "vfs", "mount"} {
		o, ok := optionOf(block, name)
		if !ok {
			continue
		}
		if group, ok := index[optionKey{block, name}]; ok {
			return []string{group}, i18n.Text{}
		}
		if block != "main" {
			return nil, reasonNoGroup
		}
		switch {
		case !rclone.PerOperation(name):
			return nil, reasonSettings
		case strings.Contains(o.Groups, "Logging"):
			return nil, reasonCLI
		}
		return []string{"config"}, i18n.Text{}
	}
	var into []string
	for _, t := range serveBlocks(serve) {
		if group, ok := index[optionKey{t, name}]; ok {
			into = append(into, group)
		}
	}
	if len(into) > 0 {
		return into, i18n.Text{}
	}
	for block := range fs.OptionsRegistry {
		if _, ok := optionOf(block, name); ok {
			return nil, reasonNoGroup
		}
	}
	return nil, reasonUnknown
}

func optionOf(block, name string) (*fs.Option, bool) {
	info, ok := fs.OptionsRegistry[block]
	if !ok {
		return nil, false
	}
	o := info.Options.Get(name)
	return o, o != nil
}

// serveBlocks returns the blocks of the serve type serve, or of every serve type when serve is
// "". Only the types that this build has are returned.
func serveBlocks(serve string) []string {
	types := rclone.ServeTypes()
	if serve == "" {
		return types
	}
	if slices.Contains(types, serve) {
		return []string{serve}
	}
	return nil
}

type optionKey struct{ block, name string }

// sectionIndex maps each block option to the first catalog group that lists it, in the order of
// the groups. For example, an option that both copy and sync list belongs to copy.
var sectionIndex = sync.OnceValue(func() map[optionKey]string {
	out := map[optionKey]string{}
	for _, g := range sections() {
		for _, ref := range g.Options {
			k := optionKey{ref.Block, ref.Name}
			if _, ok := out[k]; !ok {
				out[k] = g.Name
			}
		}
	}
	return out
})
