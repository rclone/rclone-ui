// Package operations turns the paths and option groups sent by the operation pages into work
// for rclone. For a transfer, that is a Plan, which rclone's own packages run in this process
// (Plan.Run). For a mount or serve, it is the command line of a child process. Paths are parsed
// by rclone's fspath, through core/location. Option names and values are rclone's own, and they
// are checked against rclone's option registry. Each operation is registered once, in
// operationSpecs.
package operations

import (
	"bytes"
	"encoding/json"
	"iter"
	"maps"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

// Groups holds a page's option groups. Each group holds rclone's options, such as
// `{"transfers": 4}`. Outer holds the Bisync page's switches, which are parameters of sync/bisync
// itself. Remotes holds per-remote overrides, such as `{"gdrive": {"chunk_size": "64M"}}`, which
// become connection strings.
type Groups struct {
	Copy     catalog.Group `json:"copy,omitempty"`
	Move     catalog.Group `json:"move,omitempty"`
	Sync     catalog.Group `json:"sync,omitempty"`
	Bisync   catalog.Group `json:"bisync,omitempty"`
	Filter   catalog.Group `json:"filter,omitempty"`
	Config   catalog.Group `json:"config,omitempty"`
	Metadata catalog.Group `json:"metadata,omitempty"`
	Mount    catalog.Group `json:"mount,omitempty"`
	VFS      catalog.Group `json:"vfs,omitempty"`
	Serve    catalog.Group `json:"serve,omitempty"`
	// Outer is only read by a bisync.
	Outer   *BisyncSwitches          `json:"outer,omitempty"`
	Remotes map[string]catalog.Group `json:"remotes,omitempty"`
}

// The names of the groups, as the pages and errors name them.
const (
	GroupCopy     = "copy"
	GroupMove     = "move"
	GroupSync     = "sync"
	GroupBisync   = "bisync"
	GroupFilter   = "filter"
	GroupConfig   = "config"
	GroupMetadata = "metadata"
	GroupRemotes  = "remotes"
	GroupMount    = "mount"
	GroupVFS      = "vfs"
	GroupServe    = "serve"
	GroupOuter    = "outer"
)

// optionGroups are the groups that hold rclone's options, which named and set reach by name.
var optionGroups = []string{
	GroupCopy, GroupMove, GroupSync, GroupBisync, GroupFilter, GroupConfig, GroupMetadata,
	GroupMount, GroupVFS, GroupServe,
}

// field returns the field of the option group name, or nil for a name that isn't in
// optionGroups.
func (g *Groups) field(name string) *catalog.Group {
	switch name {
	case GroupCopy:
		return &g.Copy
	case GroupMove:
		return &g.Move
	case GroupSync:
		return &g.Sync
	case GroupBisync:
		return &g.Bisync
	case GroupFilter:
		return &g.Filter
	case GroupConfig:
		return &g.Config
	case GroupMetadata:
		return &g.Metadata
	case GroupMount:
		return &g.Mount
	case GroupVFS:
		return &g.VFS
	case GroupServe:
		return &g.Serve
	}
	return nil
}

// named returns the option group name, or nil when it is empty or not a group of options.
func (g Groups) named(name string) catalog.Group {
	if f := g.field(name); f != nil {
		return *f
	}
	return nil
}

func (g *Groups) set(name string, group catalog.Group) {
	if f := g.field(name); f != nil {
		*f = group
	}
}

// Named yields each option group that is set, with its name. The outer and remotes groups are
// not option groups.
func (g Groups) Named() iter.Seq2[string, catalog.Group] {
	return func(yield func(string, catalog.Group) bool) {
		for _, name := range optionGroups {
			if group := g.named(name); group != nil && !yield(name, group) {
				return
			}
		}
	}
}

// renameRemote rewrites the groups after the remote from is renamed to to: the option values
// that name a path on it (catalog.Group.RenameRemote), the key of its remotes group, and the
// outer backup folders of a bisync. It reports whether anything changed.
func (g *Groups) renameRemote(from, to string) bool {
	changed := false
	for _, group := range g.Named() {
		if group.RenameRemote(from, to) {
			changed = true
		}
	}
	if group, ok := g.Remotes[from]; ok && from != to {
		delete(g.Remotes, from)
		g.Remotes[to] = group
		changed = true
	}
	if g.Outer != nil {
		for _, p := range []*string{&g.Outer.BackupDir1, &g.Outer.BackupDir2} {
			if renamed, ok := location.RenameRemote(*p, from, to); ok {
				*p = renamed
				changed = true
			}
		}
	}
	return changed
}

// clone returns a copy of g that shares no group with it.
func (g Groups) clone() Groups {
	out := g
	for _, name := range optionGroups {
		out.set(name, maps.Clone(g.named(name)))
	}
	if g.Outer != nil {
		outer := *g.Outer
		out.Outer = &outer
	}
	if g.Remotes != nil {
		out.Remotes = make(map[string]catalog.Group, len(g.Remotes))
		for name, group := range g.Remotes {
			out.Remotes[name] = maps.Clone(group)
		}
	}
	return out
}

// CopyArgs is the form of the Copy page. A drop in the Browser uses it too.
type CopyArgs struct {
	Sources     []string `json:"sources,omitempty"`
	Destination string   `json:"destination,omitempty"`
	Options     Groups   `json:"options,omitzero"`
}

type MoveArgs CopyArgs

type SyncArgs struct {
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination,omitempty"`
	Options     Groups `json:"options,omitzero"`
}

// BisyncArgs is the form of the Bisync page. Its switches are in Options.Outer.
type BisyncArgs SyncArgs

// BisyncSwitches are the parameters of sync/bisync (cmd/bisync/rc.go), which the Bisync page
// sets as its switches. Each is left out when it is off or empty, as rclone's default.
type BisyncSwitches struct {
	DryRun                bool   `json:"dryRun,omitempty"`
	MaxDelete             *int   `json:"maxDelete,omitempty"`
	Resync                bool   `json:"resync,omitempty"`
	CheckAccess           bool   `json:"checkAccess,omitempty"`
	Force                 bool   `json:"force,omitempty"`
	CreateEmptySrcDirs    bool   `json:"createEmptySrcDirs,omitempty"`
	RemoveEmptyDirs       bool   `json:"removeEmptyDirs,omitempty"`
	NoCleanup             bool   `json:"noCleanup,omitempty"`
	IgnoreListingChecksum bool   `json:"ignoreListingChecksum,omitempty"`
	Resilient             bool   `json:"resilient,omitempty"`
	CheckFilename         string `json:"checkFilename,omitempty"`
	FiltersFile           string `json:"filtersFile,omitempty"`
	Workdir               string `json:"workdir,omitempty"`
	BackupDir1            string `json:"backupDir1,omitempty"`
	BackupDir2            string `json:"backupDir2,omitempty"`
	CheckSync             string `json:"checkSync,omitempty"`
	ResyncMode            string `json:"resyncMode,omitempty"`
	ConflictResolve       string `json:"conflictResolve,omitempty"`
	ConflictLoser         string `json:"conflictLoser,omitempty"`
	ConflictSuffix        string `json:"conflictSuffix,omitempty"`
	Recover               bool   `json:"recover,omitempty"`
	Compare               string `json:"compare,omitempty"`
	NoSlowHash            bool   `json:"noSlowHash,omitempty"`
	SlowHashSyncOnly      bool   `json:"slowHashSyncOnly,omitempty"`
	DownloadHash          bool   `json:"downloadHash,omitempty"`
	MaxLock               string `json:"maxLock,omitempty"`
}

type DeleteArgs struct {
	Sources []string `json:"sources,omitempty"`
	Options Groups   `json:"options,omitzero"`
}

// PurgeArgs is the form of the Purge page. Only its config group is read.
type PurgeArgs DeleteArgs

// DownloadArgs is the form of the Download page: the previewed URL, the file name and the
// destination folder.
type DownloadArgs struct {
	URL         string `json:"url,omitempty"`
	Filename    string `json:"filename,omitempty"`
	Destination string `json:"destination,omitempty"`
	Options     Groups `json:"options,omitzero"`
}

// SaveArgs holds a save from the Commander, which copies an entry to a path on this computer.
type SaveArgs struct {
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination,omitempty"`
	Options     Groups `json:"options,omitzero"`
}

// MountArgs is the form of the Mount page. It is also used for an automount.
// Destination is the mount point, or `*` on Windows to let rclone pick a drive.
type MountArgs struct {
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination,omitempty"`
	Options     Groups `json:"options,omitzero"`
}

// ServeArgs is the form of the Serve page. When Addr is set, it takes precedence over `addr`
// in the serve group.
type ServeArgs struct {
	Type    string `json:"type,omitempty"`
	Source  string `json:"source,omitempty"`
	Addr    string `json:"addr,omitempty"`
	Options Groups `json:"options,omitzero"`
}

func (a CopyArgs) paths() []string     { return append(slices.Clone(a.Sources), a.Destination) }
func (a MoveArgs) paths() []string     { return CopyArgs(a).paths() }
func (a SyncArgs) paths() []string     { return []string{a.Source, a.Destination} }
func (a BisyncArgs) paths() []string   { return SyncArgs(a).paths() }
func (a DeleteArgs) paths() []string   { return a.Sources }
func (a PurgeArgs) paths() []string    { return a.Sources }
func (a DownloadArgs) paths() []string { return []string{a.Destination} }
func (a SaveArgs) paths() []string     { return []string{a.Source, a.Destination} }
func (a MountArgs) paths() []string    { return []string{a.Source} }
func (a ServeArgs) paths() []string    { return []string{a.Source} }

func (a *CopyArgs) pathFields() []*string     { return append(sliceFields(a.Sources), &a.Destination) }
func (a *MoveArgs) pathFields() []*string     { return append(sliceFields(a.Sources), &a.Destination) }
func (a *SyncArgs) pathFields() []*string     { return []*string{&a.Source, &a.Destination} }
func (a *BisyncArgs) pathFields() []*string   { return []*string{&a.Source, &a.Destination} }
func (a *DeleteArgs) pathFields() []*string   { return sliceFields(a.Sources) }
func (a *PurgeArgs) pathFields() []*string    { return sliceFields(a.Sources) }
func (a *DownloadArgs) pathFields() []*string { return []*string{&a.Destination} }
func (a *SaveArgs) pathFields() []*string     { return []*string{&a.Source, &a.Destination} }
func (a *MountArgs) pathFields() []*string    { return []*string{&a.Source, &a.Destination} }
func (a *ServeArgs) pathFields() []*string    { return []*string{&a.Source} }

func sliceFields(paths []string) []*string {
	out := make([]*string, len(paths))
	for i := range paths {
		out[i] = &paths[i]
	}
	return out
}

// options holds one group's options, keyed by rclone's option name. The values are kept as the
// page wrote them. Numbers are json.Number, so a size or a duration keeps every digit.
type options map[string]any

// decodeJSON decodes one JSON value and keeps its numbers as written. An empty value or null
// leaves v unchanged.
func decodeJSON(raw json.RawMessage, v any) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(v)
}

// decodeGroup decodes the values of one option group and converts its keys to rclone's option
// names. It refuses two spellings of the same option, such as `dry-run` and `dry_run`, because we
// can't know which one the page meant. name is the group's name, for the error.
func decodeGroup(name string, group catalog.Group) (options, error) {
	return decodeGroupOn("options."+name, name, group)
}

// decodeGroupOn works like decodeGroup, with its refusals on field.
func decodeGroupOn(field, name string, group catalog.Group) (options, error) {
	out := options{}
	spelled := map[string]string{}
	for _, key := range slices.Sorted(maps.Keys(group)) {
		option := catalog.NormalizeOptionName(key)
		if other, twice := spelled[option]; twice {
			return nil, errs.Field(field, "‘%s’ and ‘%s’ are the same option", other, key)
		}
		spelled[option] = key
		var v any
		if err := decodeJSON(group[key], &v); err != nil {
			// i18n: The name of a group of options (such as vfs), an option's name, and the error from the JSON reader.
			return nil, errs.Field(field, "The %s option %s is not valid JSON: %v", name, key, err)
		}
		out[option] = v
	}
	return out, nil
}

// transferGroup decodes one group of a transfer, whose options rclone reads from blocks. Each key
// must be an option's name as rclone writes it, and one that a transfer can set (checkKey). A
// cleared field has no value, so its key isn't checked.
func (g Groups) transferGroup(name string, blocks ...string) (options, error) {
	group := g.named(name)
	out := options{}
	for _, key := range slices.Sorted(maps.Keys(group)) {
		var v any
		if err := decodeJSON(group[key], &v); err != nil {
			return nil, errs.Field("options."+name, "The %s option %s is not valid JSON: %v", name, key, err)
		}
		if isBlank(v) {
			continue
		}
		// On the group's field, so that the page shows it under that group's editor.
		if err := checkKey("options."+name, key, blocks); err != nil {
			return nil, err
		}
		out[key] = v
	}
	return out, nil
}

// remoteOverrides is the decoded remotes group. It maps each remote to its backend options, as
// the page wrote them.
type remoteOverrides map[string]map[string]any

func (g Groups) remotes() (remoteOverrides, error) {
	out := remoteOverrides{}
	for name, group := range g.Remotes {
		o := map[string]any{}
		for key, raw := range group {
			var v any
			if err := decodeJSON(raw, &v); err != nil {
				// i18n: An option's name, the remote's name, and the error from the JSON reader.
				return nil, errs.Field("options."+GroupRemotes, "The option %s of %s is not valid JSON: %v", key, name, err)
			}
			o[key] = v
		}
		out[name] = o
	}
	return out, nil
}

// isBlank reports whether the user cleared a field. A cleared option is left out entirely,
// because rclone would refuse a blank value.
func isBlank(v any) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && strings.TrimSpace(s) == ""
}
