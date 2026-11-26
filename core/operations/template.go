package operations

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/rclone"
)

var templateTags = append(slices.Clone(transferTags), OperationMount, OperationServe)

var formGroupsOf = func() map[Operation][]formGroup {
	transfer := func(own Operation) []formGroup {
		return []formGroup{
			{string(own), []string{"copy", "sync"}},
			{GroupFilter, []string{GroupFilter}},
			{GroupConfig, []string{GroupConfig}},
			{GroupMetadata, []string{GroupMetadata}},
		}
	}
	return map[Operation][]formGroup{
		OperationCopy:   transfer(OperationCopy),
		OperationMove:   transfer(OperationMove),
		OperationSync:   transfer(OperationSync),
		OperationBisync: transfer(OperationBisync),
		OperationDelete: {
			{GroupFilter, []string{GroupFilter}},
			{GroupConfig, []string{GroupConfig, "copy", "sync"}},
			{GroupMetadata, []string{GroupMetadata}},
		},
		OperationPurge: {{GroupConfig, []string{GroupConfig, "copy", "sync"}}},
		OperationMount: {
			{GroupMount, []string{GroupMount}},
			{GroupVFS, []string{GroupVFS}},
			{GroupConfig, []string{GroupConfig}},
			{GroupFilter, []string{GroupFilter}},
			{GroupMetadata, []string{GroupMetadata}},
		},
		OperationServe: {
			{GroupServe, nil},
			{GroupVFS, []string{GroupVFS}},
			{GroupConfig, []string{GroupConfig}},
			{GroupFilter, []string{GroupFilter}},
			{GroupMetadata, []string{GroupMetadata}},
		},
	}
}()

type formGroup struct {
	name string
	from []string
}

type FormSection struct {
	Group   string
	Catalog []string
}

func FormSections(op Operation, serve string) []FormSection {
	var out []FormSection
	for _, fg := range formGroupsOf[op] {
		from := slices.Clone(fg.from)
		if fg.from == nil {
			for _, t := range rclone.ServeTypes() {
				if serve == "" || serve == t {
					from = append(from, "serve."+t)
				}
			}
		}
		out = append(out, FormSection{Group: fg.name, Catalog: from})
	}
	return out
}

func FormGroups(op Operation, sorted catalog.Sorted) (Groups, []catalog.SkippedFlag) {
	var g Groups
	taken := map[string]bool{}
	for _, fg := range formGroupsOf[op] {
		from := fg.from
		if from == nil {
			for name := range sorted.Groups {
				if strings.HasPrefix(name, "serve.") {
					from = append(from, name)
				}
			}
			slices.Sort(from)
		}
		for _, name := range from {
			taken[name] = true
			for key, value := range sorted.Groups[name] {
				group := g.named(fg.name)
				if group == nil {
					group = catalog.Group{}
					g.set(fg.name, group)
				}
				group[key] = value
			}
		}
	}
	skipped := slices.Clone(sorted.Skipped)
	why := unusedWhy(op)
	left := map[string]bool{}
	for _, name := range slices.Sorted(maps.Keys(sorted.Groups)) {
		if taken[name] {
			continue
		}
		for _, key := range slices.Sorted(maps.Keys(sorted.Groups[name])) {
			if !left[key] {
				left[key] = true
				skipped = append(skipped, catalog.Skip(key, why))
			}
		}
	}
	return g, skipped
}

func unusedWhy(op Operation) i18n.Text {
	switch op {
	case OperationCopy:
		return i18n.M("A copy doesn't use this option.")
	case OperationMove:
		return i18n.M("A move doesn't use this option.")
	case OperationSync:
		return i18n.M("A sync doesn't use this option.")
	case OperationBisync:
		return i18n.M("A bisync doesn't use this option.")
	case OperationDelete:
		return i18n.M("A delete doesn't use this option.")
	case OperationPurge:
		return i18n.M("A purge doesn't use this option.")
	case OperationMount:
		return i18n.M("A mount doesn't use this option.")
	case OperationServe:
		return i18n.M("A serve doesn't use this option.")
	}
	return i18n.M("This operation doesn't use this option.")
}

func TemplateGroups(op Operation, serve string, options catalog.Group) (Groups, []catalog.SkippedFlag, error) {
	if !slices.Contains(templateTags, op) {
		return Groups{}, nil, errs.Errorf("A template is not for %s.", op)
	}
	g, skipped := FormGroups(op, catalog.SortOptions(options, serve))
	return g, skipped, nil
}

func TemplateArgs(tag Operation, sources []string, destination string, options catalog.Group) (Form, error) {
	if !slices.Contains(transferTags, tag) {
		return Form{}, errs.Errorf("A template does not run %s: apply it in its form.", tag)
	}
	groups, _, err := TemplateGroups(tag, "", options)
	if err != nil {
		return Form{}, err
	}
	switch tag {
	case OperationCopy:
		return CopyArgs{Sources: sources, Destination: destination, Options: groups}.Form(), nil
	case OperationMove:
		return MoveArgs{Sources: sources, Destination: destination, Options: groups}.Form(), nil
	case OperationDelete:
		return DeleteArgs{Sources: sources, Options: groups}.Form(), nil
	case OperationPurge:
		return PurgeArgs{Sources: sources, Options: groups}.Form(), nil
	}
	if len(sources) > 1 {
		return Form{}, errs.New("The template needs one source to run.")
	}
	first := ""
	if len(sources) == 1 {
		first = sources[0]
	}
	if tag == OperationSync {
		return SyncArgs{Source: first, Destination: destination, Options: groups}.Form(), nil
	}
	return BisyncArgs{Source: first, Destination: destination, Options: groups}.Form(), nil
}

func TemplateFlags(options catalog.Group, exe, goos string) (string, error) {
	blocks := flagBlocks()
	var words []string
	for _, key := range slices.Sorted(maps.Keys(options)) {
		var v any
		if err := decodeJSON(options[key], &v); err != nil {
			return "", errs.Field("options", "The value of %s is not valid JSON.", key)
		}
		if list, ok := v.([]any); isBlank(v) || ok && len(list) == 0 {
			continue
		}
		name := catalog.NormalizeOptionName(key)
		var flags []string
		for _, block := range blocks {
			if option, ok := blockOption(block, name); ok {
				flags, _ = renderFlag(option, v, exe)
				break
			}
		}
		if flags == nil {
			flags = plainFlags(name, v)
		}
		for _, f := range flags {
			words = append(words, shellArg(f, goos == "windows"))
		}
	}
	return strings.Join(words, " "), nil
}

func flagBlocks() []string {
	first := append([]string{blockMain, blockFilter, GroupVFS, GroupMount}, rclone.ServeTypes()...)
	var rest []string
	for name := range fs.OptionsRegistry {
		if !slices.Contains(first, name) {
			rest = append(rest, name)
		}
	}
	slices.Sort(rest)
	return append(first, rest...)
}

func plainFlags(name string, v any) []string {
	flag := "--" + strings.ReplaceAll(name, "_", "-")
	values, ok := v.([]any)
	if !ok {
		values = []any{v}
	}
	var out []string
	for _, value := range values {
		text, err := elementText(value)
		if err != nil {
			text = fmt.Sprint(value)
		}
		out = append(out, flag+"="+text)
	}
	return out
}
