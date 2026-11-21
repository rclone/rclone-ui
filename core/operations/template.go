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

// templateTags lists the operations that a template can be for: the transfers, and the mount and
// serve, whose templates are applied in their pages.
var templateTags = append(slices.Clone(transferTags), OperationMount, OperationServe)

// formGroupsOf lists, for each operation that a template can be for, the groups of its form and
// the catalog groups whose options go into each one, in order. A catalog group that no form group
// lists is left out of that operation's form.
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
		// A delete has no group of its own, so its config group takes the copy and sync options,
		// such as max_delete.
		OperationDelete: {
			{GroupFilter, []string{GroupFilter}},
			{GroupConfig, []string{GroupConfig, "copy", "sync"}},
			{GroupMetadata, []string{GroupMetadata}},
		},
		// A purge removes whole folders, so it reads no filters.
		OperationPurge: {{GroupConfig, []string{GroupConfig, "copy", "sync"}}},
		OperationMount: {
			{GroupMount, []string{GroupMount}},
			{GroupVFS, []string{GroupVFS}},
			{GroupConfig, []string{GroupConfig}},
			{GroupFilter, []string{GroupFilter}},
			{GroupMetadata, []string{GroupMetadata}},
		},
		// The serve group takes the serve.<type> groups, which SortOptions fills for one type, or
		// for every type when none is named.
		OperationServe: {
			{GroupServe, nil},
			{GroupVFS, []string{GroupVFS}},
			{GroupConfig, []string{GroupConfig}},
			{GroupFilter, []string{GroupFilter}},
			{GroupMetadata, []string{GroupMetadata}},
		},
	}
}()

// formGroup is one group of a form, and the catalog groups whose options it takes. A nil from
// means every serve.<type> group.
type formGroup struct {
	name string
	from []string
}

// FormSection is one group of an operation's form, and the catalog groups whose options it takes.
type FormSection struct {
	// Group is the form's group, such as "config".
	Group string
	// Catalog lists the catalog's groups, such as "config", "copy" or "serve.http".
	Catalog []string
}

// FormSections returns the groups of op's form, each with the catalog groups whose options
// FormGroups puts into it, so that a caller can list the options that each group takes. serve
// names the serve type whose catalog group a serve's group takes, or "" for every type that rclone
// has. It returns nil for an operation that no template can be for.
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

// FormGroups puts options that catalog.SortOptions sorted into the groups of op's form, as op's
// page shows them. Copy, Move, Sync and Bisync take the copy and sync options in their own group.
// A delete takes them in its config group, and so does a purge, which takes nothing else. A mount
// and a serve take their own groups. It returns the options that the form leaves out as skipped,
// after the ones that SortOptions skipped. For an operation that no template can be for, every
// option is skipped.
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
	left := map[string]bool{} // an option such as addr is in the group of every serve type
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

// unusedWhy returns why op's form leaves out an option of a template.
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

// TemplateGroups sorts a template's flat options into the groups of op's form, as FormGroups
// does, and returns the options that the form leaves out. serve is a serve's type, or "" for
// every type. It refuses an operation that no template can be for. Each value is kept as the
// template wrote it.
func TemplateGroups(op Operation, serve string, options catalog.Group) (Groups, []catalog.SkippedFlag, error) {
	if !slices.Contains(templateTags, op) {
		return Groups{}, nil, errs.Errorf("A template is not for %s.", op)
	}
	g, skipped := FormGroups(op, catalog.SortOptions(options, serve))
	return g, skipped, nil
}

// TemplateArgs returns the form that runs a template as the transfer tag, as the operation's page
// would send it: the template's paths, and its options sorted into the form's groups
// (TemplateGroups). An option that the operation doesn't use is left out, as the page leaves it
// out when the template is applied there. A single-source form (sync, bisync) refuses a template
// with several sources, which templates.Check refuses too. Paths that are missing are left to the
// start, which says which one is missing.
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

// TemplateFlags writes a template's options as the flags of an rclone command line, for the
// template's export. Each option is written with the flag that rclone registers for it, as a
// mount's are (renderFlag), so a list option that is a repeated flag gets one flag per element,
// and the app's own metadata mapper runs exe. Each flag is quoted for the shell of goos:
// PowerShell on Windows, and a POSIX shell anywhere else. The flags are sorted by name, and a
// blank value is left out.
//
// rclone's blocks are searched in the order that its command line defines their flags. A name
// that no block has, or a value that rclone can't read, is still written as the template holds
// it, so the export keeps every option.
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

// flagBlocks returns rclone's option blocks in the order that its command line defines their
// flags: main, filter, vfs, mount, the serve types, and then the rest by name.
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

// plainFlags writes an option that rclone can't read as `--name=text`, with one flag for each
// element of a list.
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
