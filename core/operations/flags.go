package operations

import (
	"fmt"
	"maps"
	"slices"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/metadatamap"
)

// This file builds the command lines of the mount and serve children by turning a page's groups
// into rclone flags. Each key on the page is an option name from rclone's registry
// (`options/info`), and the flag is the one that rclone registers for that option. A key that is
// not an option of the group's blocks is refused here, rather than leaving a child that fails to
// start.

func blockOption(block, name string) (*fs.Option, bool) {
	info, ok := fs.OptionsRegistry[block]
	if !ok {
		return nil, false
	}
	o := info.Options.Get(name)
	return o, o != nil
}

// hasBlock reports whether an options block is linked into this binary.
func hasBlock(block string) bool {
	_, ok := fs.OptionsRegistry[block]
	return ok
}

// childReason is why a page can't set one of childFlags.
type childReason int

const (
	setByApp     childReason = iota // the app sets it on every child
	appWide                         // it applies to the whole app
	watchedMount                    // it would stop the app from running and watching a mount
	watchedServe                    // the same, for a serve
)

// childFlags lists the options that the app sets on every child itself, so a page can't set
// them. Each value is the reason shown to the user (childRefusal).
var childFlags = map[string]childReason{
	"ask_password":   setByApp,
	"use_json_log":   setByApp,
	"log_level":      appWide,
	"bwlimit":        appWide,
	"tpslimit":       appWide,
	"tpslimit_burst": appWide,
	"user_agent":     setByApp,
	// Both would stop the app from managing the child. A daemon forks and exits, and stdio
	// serves over the child's stdin.
	"daemon": watchedMount,
	"stdio":  watchedServe,
}

// childRefusal returns the refusal of the option name, which is one of childFlags, with why.
// The error uses the option name as the page wrote it.
func childRefusal(name string, why childReason) error {
	switch why {
	case appWide:
		return errs.Field(name, "%s applies to the whole app and can't be set for a single mount or serve", name)
	case watchedMount:
		return errs.Field(name, "%s cannot be used here: Rclone UI runs and watches the mount itself", name)
	case watchedServe:
		return errs.Field(name, "%s cannot be used here: Rclone UI runs and watches the serve itself", name)
	}
	return errs.Field(name, "%s is set by Rclone UI for every mount and serve", name)
}

// flagsOf renders one group's options as flags, sorted by name. Each option is looked up in the
// given blocks, and the first block that has it is used. exe is put in front of the app's own
// metadata mapper.
func flagsOf(group string, o options, blocks []string, exe string) ([]string, error) {
	var args []string
	for _, name := range slices.Sorted(maps.Keys(o)) {
		v := o[name]
		if list, ok := v.([]any); isBlank(v) || ok && len(list) == 0 {
			continue
		}
		if why, ok := childFlags[name]; ok {
			return nil, childRefusal(name, why)
		}
		var option *fs.Option
		for _, b := range blocks {
			if found, ok := blockOption(b, name); ok {
				option = found
				break
			}
		}
		if option == nil {
			// i18n: An option's name, then the name of the group of options in the form, such as vfs.
			return nil, errs.Field(name, "‘%s’ is not one of the %s options", name, group)
		}
		flags, err := renderFlag(option, v, exe)
		if err != nil {
			return nil, err
		}
		args = append(args, flags...)
	}
	return args, nil
}

// renderFlag renders one option as `--name=value`, using the flag that rclone registers for it
// (flagName). The value is first parsed by rclone's parser for the option (valueOf), so a bad
// value becomes a form error rather than a child that fails to start.
//
// The text is written as the page gave it. A []string option is a repeated flag, because
// fs.Option.Set appends to it, so it gets one flag per element. A comma list or an argv that was
// given as a list gets one flag, with the list written the way rclone writes it (fs.CommaSepList,
// fs.SpaceSepList). The flag then splits it back into the same elements. The app's own metadata
// mapper is stored without an executable path, so exe is put in front of it.
func renderFlag(option *fs.Option, v any, exe string) ([]string, error) {
	flag := "--" + flagName(option)
	value, err := valueOf(option.Default, v)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", option.Name, err)
	}
	switch value := value.(type) {
	case []string:
		args := make([]string, 0, len(value))
		for _, text := range value {
			args = append(args, flag+"="+text)
		}
		return args, nil
	case fs.SpaceSepList:
		if option.Name == "metadata_mapper" {
			return []string{flag + "=" + fs.SpaceSepList(metadatamap.Runnable(value, exe)).String()}, nil
		}
	}
	if text, err := elementText(v); err == nil {
		return []string{flag + "=" + text}, nil
	}
	return []string{flag + "=" + fmt.Sprint(value)}, nil
}

// flagName returns the name of the flag that rclone gives one of a child's options. rclone adds
// a child's option blocks without a prefix, because flags.AddFlagsFromOptions sets NoPrefix on
// each option at that point. So this calls FlagName("") on a copy with NoPrefix set.
//
// The copy matters for the main and filter blocks. Only rclone's command line adds their flags,
// so in this process their options still have NoPrefix unset, and FlagName("") would return
// "-name". The serve commands add their own blocks, and the vfs and proxy blocks, at init.
func flagName(o *fs.Option) string {
	c := o.Copy()
	c.NoPrefix = true
	return c.FlagName("")
}

// blockGroup is one of a page's groups, with its options and the rclone blocks they belong to.
type blockGroup struct {
	group   string
	options options
	blocks  []string
}

// commandFlags returns the flags for the option groups of a mount or a serve. The flags of each
// group in own come first, from that group's blocks. Then come the config and metadata groups as
// rclone's main options, and the filter group and metadata rules as filter flags.
func commandFlags(g Groups, exe string, own ...blockGroup) ([]string, error) {
	var args []string
	for _, o := range own {
		flags, err := flagsOf(o.group, o.options, o.blocks, exe)
		if err != nil {
			return nil, err
		}
		args = append(args, flags...)
	}
	config, filter, err := mergedGroups("", g, false)
	if err != nil {
		return nil, err
	}
	mainFlags, err := flagsOf(GroupConfig, config, []string{blockMain}, exe)
	if err != nil {
		return nil, err
	}
	filterFlags, err := flagsOf(GroupFilter, filter, []string{blockFilter}, exe)
	if err != nil {
		return nil, err
	}
	return append(append(args, mainFlags...), filterFlags...), nil
}
