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

type Options map[string]any

const (
	blockMain   = "main"
	blockFilter = "filter"
)

func valueOf(template any, v any) (any, error) { return rclone.ParseOption(template, v) }

func elementText(v any) (string, error) { return rclone.OptionText(v) }

func storedValue(v any) any {
	if texts, err := rclone.OptionTexts(v); err == nil {
		return anyList(texts)
	}
	if text, err := rclone.OptionText(v); err == nil {
		return text
	}
	return v
}

func anyList(texts []string) []any {
	out := make([]any, len(texts))
	for i, t := range texts {
		out[i] = t
	}
	return out
}

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

var transferTags = []Operation{
	OperationCopy, OperationMove, OperationSync, OperationBisync, OperationDelete, OperationPurge,
}

func CheckOption(tag Operation, key string) error {
	if !slices.Contains(transferTags, tag) {
		return nil
	}
	return checkKey("options", key, []string{blockMain, blockFilter})
}

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
