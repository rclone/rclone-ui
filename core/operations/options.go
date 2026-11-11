package operations

import (
	"fmt"
	"maps"
	"reflect"
	"slices"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/filter"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Options holds values for one of rclone's option blocks, keyed by rclone's option names, in the
// form that a plan stores them. A scalar is stored as the text a person would type after its flag,
// as the page gave it ("5m", "10M", "off", "true", "8"). A list option is stored as a list of
// texts. rclone's parser for each option (rclone.ParseOption) reads the values when the plan is
// built, and again when it runs.
type Options map[string]any

// The option blocks that a plan sets.
const (
	blockMain   = "main"
	blockFilter = "filter"
)

// valueOf parses v, the value that a page or a plan holds for an option, into the option's own
// type (the type of template), the same way the option's flag would (rclone.ParseOption). A JSON
// number or boolean is read as its literal text, so a bare number for a size means KiB, as in
// `--buffer-size 1000`. A single text for a []string option (a repeated flag) is one element. A
// single text for a comma list or an argv (fs.SpaceSepList, such as metadata_mapper) is split by
// rclone.
func valueOf(template any, v any) (any, error) { return rclone.ParseOption(template, v) }

// elementText returns a scalar as text, such as an element of a list option or the value of a
// backend option.
func elementText(v any) (string, error) { return rclone.OptionText(v) }

// storedValue converts a value to the form that a plan stores. A scalar becomes its text as
// given, and a list becomes the texts of its elements. Anything else is kept as it is, so that
// valueOf refuses it later.
func storedValue(v any) any {
	if texts, err := rclone.OptionTexts(v); err == nil {
		return anyList(texts)
	}
	if text, err := rclone.OptionText(v); err == nil {
		return text
	}
	return v
}

// anyList converts texts to []any, the type that JSON decoding produces for a list.
func anyList(texts []string) []any {
	out := make([]any, len(texts))
	for i, t := range texts {
		out[i] = t
	}
	return out
}

// blockOf returns the registry entry of one of rclone's option blocks, and the items of a fresh
// copy of its struct (configstruct.Items), which give the names and types of its options.
func blockOf(name string) (fs.OptionsInfo, map[string]configstruct.Item, error) {
	info, ok := fs.OptionsRegistry[name]
	if !ok {
		return fs.OptionsInfo{}, nil, fmt.Errorf("rclone's %s options are not linked in", name)
	}
	var opt any
	switch name {
	case blockMain:
		opt = &fs.ConfigInfo{}
	case blockFilter:
		opt = &filter.Options{}
	default:
		return fs.OptionsInfo{}, nil, fmt.Errorf("no plan sets rclone's %s options", name)
	}
	items, err := configstruct.Items(opt)
	if err != nil {
		return fs.OptionsInfo{}, nil, err
	}
	byName := make(map[string]configstruct.Item, len(items))
	for _, it := range items {
		byName[it.Name] = it
	}
	return info, byName, nil
}

func unknownOption(block, name string) error {
	if block == blockFilter {
		return errs.Errorf("‘%s’ is not an rclone filter option", name)
	}
	return errs.Errorf("‘%s’ is not an rclone option", name)
}

// checkKey returns why a transfer can't take the option written key, when rclone reads the
// group's options from blocks. The key must name an option of one of the blocks, written as
// rclone writes it (`dry_run`, not `--dry-run`), and the option must be one that a transfer can
// set for itself (rclone.PerOperation).
func checkKey(field, key string, blocks []string) error {
	name := catalog.NormalizeOptionName(key)
	known := slices.ContainsFunc(blocks, func(block string) bool {
		_, ok := blockOption(block, name)
		return ok
	})
	switch {
	case !known:
		return errs.Field(field, "%s is not one of the options rclone takes here.", key)
	case name != key:
		// i18n: An option's name as it was written, then as rclone writes it, such as "dry-run is written dry_run here."
		return errs.Field(field, "%s is written %s here.", key, name)
	case !rclone.PerOperation(name):
		return notPerOperation(field, name)
	}
	return nil
}

func notPerOperation(field, name string) error {
	return errs.Field(field, "%s can't be set for one transfer, because rclone sets it once: for the whole app, or when it first opens a remote.", name)
}

// transferTags lists the operations that run as transfers, as templates tag them. Mount and
// serve run as their own process, with the options as command-line flags, so every option
// takes effect there.
var transferTags = []Operation{
	OperationCopy, OperationMove, OperationSync, OperationBisync, OperationDelete, OperationPurge,
}

// CheckOption returns why a transfer of the operation tag (copy, move, sync, bisync, delete or
// purge) can't take the option written key: rclone has no option of that name for a transfer,
// the key is a flag's spelling (`--dry-run`, `dry-run`), or the option is one that rclone sets
// once for the whole app (rclone.NotPerOperation). It returns nil for any other tag.
func CheckOption(tag Operation, key string) error {
	if !slices.Contains(transferTags, tag) {
		return nil
	}
	return checkKey("options", key, []string{blockMain, blockFilter})
}

// CheckTemplate refuses a template whose options set a metadata mapper without `metadata`
// (checkMapper), or two spellings of one option. It also refuses a template for a transfer (one
// of tags is in transferTags) whose options set one of rclone.NotPerOperation, however its name
// is spelled. Other keys are left to the page, which shows an unknown option in its Config
// section.
func CheckTemplate(tags []Operation, options catalog.Group) error {
	decoded, err := decodeGroupOn("options", "template", options)
	if err != nil {
		return err
	}
	if hasMapper(decoded) && checkMapper(decoded) != nil {
		return errs.Field("options", noMetadata)
	}
	if !slices.ContainsFunc(tags, func(tag Operation) bool { return slices.Contains(transferTags, tag) }) {
		return nil
	}
	for _, key := range slices.Sorted(maps.Keys(options)) {
		if name := catalog.NormalizeOptionName(key); !rclone.PerOperation(name) {
			return notPerOperation("options", name)
		}
	}
	return nil
}

// typedOptions parses o into the types of a block's options. It refuses a name that the block's
// registry does not list, because configstruct would silently skip it. It also refuses a value
// that rclone can't parse, and a main option that rclone's Reload would refuse (checkReload).
func typedOptions(block string, o Options) (map[string]any, error) {
	info, items, err := blockOf(block)
	if err != nil {
		return nil, err
	}
	typed := make(map[string]any, len(o))
	for _, name := range slices.Sorted(maps.Keys(o)) {
		item, ok := items[name]
		if !ok || info.Options.Get(name) == nil {
			return nil, unknownOption(block, name)
		}
		v, err := valueOf(item.Value, o[name])
		if err != nil {
			return nil, errs.Errorf("%s: %w", name, err)
		}
		typed[name] = v
	}
	if block == blockMain {
		if err := checkReload(typed); err != nil {
			return nil, err
		}
	}
	return typed, nil
}

// checkReload checks a plan's typed main options. It refuses the values that rclone's
// ConfigInfo.Reload would refuse or raise to a minimum (fs/config.go), and it refuses interactive.
// A plan's options never go through Reload, because Reload also sets rclone's process-wide log
// level. Without its minimums, checkers 0 makes a transfer hang after a stop, transfers 0
// finishes without doing anything, and low_level_retries 0 crashes the app. interactive would
// wait forever for input on the app's stdin.
func checkReload(typed map[string]any) error {
	for _, name := range []string{"transfers", "checkers", "retries", "low_level_retries"} {
		if n, ok := typed[name].(int); ok && n <= 0 {
			return errs.Field(name, "%s must be at least 1", name)
		}
	}
	compareDest, _ := typed["compare_dest"].([]string)
	copyDest, _ := typed["copy_dest"].([]string)
	if len(compareDest) > 0 && len(copyDest) > 0 {
		return errs.New("compare_dest and copy_dest can’t be used together")
	}
	if suffix, _ := typed["partial_suffix"].(string); len(suffix) > 16 {
		return errs.Field("partial_suffix", "partial_suffix can be at most 16 characters")
	}
	if interactive, _ := typed["interactive"].(bool); interactive {
		return errs.Field("interactive", "interactive can’t be used here: Rclone UI has no terminal to ask in")
	}
	return nil
}

// storedOptions converts a group's options to the form that a plan stores. Blank values are left
// out, and names and values are checked against the block. A scalar is kept as the page gave it
// (storedValue). A list option is stored as the elements that rclone parsed, so the text of a
// comma list or an argv is split the way rclone splits it.
func storedOptions(block string, o options) (Options, error) {
	set := Options{}
	for name, v := range o {
		if !isBlank(v) {
			set[name] = v
		}
	}
	typed, err := typedOptions(block, set)
	if err != nil {
		return nil, err
	}
	if len(typed) == 0 {
		return nil, nil
	}
	out := make(Options, len(typed))
	for name, v := range typed {
		if rv := reflect.ValueOf(v); rclone.IsListType(rv.Type()) {
			out[name] = anyList(rv.Convert(reflect.TypeFor[[]string]()).Interface().([]string))
			continue
		}
		out[name] = storedValue(set[name])
	}
	return out, nil
}

// setOptions sets o on opt, which is a block's struct (a copy of rclone's *fs.ConfigInfo or
// filter.Options). Each value is parsed by rclone's parser for its option and then set on its
// field (rclone.SetFields). Only the fields named in o are changed.
func setOptions(block string, o Options, opt any) error {
	if len(o) == 0 {
		return nil
	}
	typed, err := typedOptions(block, o)
	if err != nil {
		return err
	}
	return rclone.SetFields(opt, typed)
}
