package operations

import (
	"maps"
	"path"
	"reflect"
	"slices"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

// Kind is the kind of a source, as reported by rclone.
type Kind string

const (
	KindFile   Kind = "file"
	KindFolder Kind = "folder"
)

// Kinds holds the kind of each source path, keyed by the path as given (describeSources).
type Kinds map[string]Kind

// kindOf returns the kind that rclone reported for p. Without one, it falls back to the only
// hint the string carries, which is a trailing separator. A trailing slash is not reliable, so
// starting a transfer always asks rclone first.
func kindOf(p string, k Kinds) Kind {
	if kind, ok := k[p]; ok {
		return kind
	}
	if at, err := location.Split(p); err == nil && at.Folder {
		return KindFolder
	}
	return KindFile
}

// checkPaths refuses a path that rclone would refuse or misread, using the message from
// location.Problem.
func checkPaths(paths ...string) error {
	for _, p := range paths {
		if p == "" {
			return errs.New("A path is missing")
		}
		if err := location.Refusal(p); err != nil {
			return err
		}
	}
	return nil
}

// split splits a path that checkPaths already accepted into its root and the rest. A path that
// rclone refuses gives an empty result, and checkPaths has already reported why.
func split(p string) location.Fs {
	at, _ := location.Split(p)
	return at
}

// required returns the error that the page would show for a form with missing paths.
func required(hasSource bool, destination string) error {
	if !hasSource {
		return errs.New("Please select a source path")
	}
	if destination == "" {
		return errs.New("Please select a destination path")
	}
	return nil
}

// isFilterOption reports whether name is an option of rclone's filter block, which includes the
// metadata rules.
func isFilterOption(name string) bool {
	_, ok := blockOption(blockFilter, name)
	return ok
}

// mergedGroups returns an operation's main and filter options as the page wrote them. It starts
// with the operation's own group (own, or "" for none), and the config group overrides it. Then
// the metadata group is split by rclone's blocks. Its rules (metadata_include…) go to the filter
// options, and the rest (metadata, metadata_mapper) go to the main options. The metadata group
// comes last, so the same option in another group never overrides what the page shows.
//
// A transfer's keys must be written as rclone writes them, and name options that a transfer can
// set (Groups.transferGroup). A mount or a serve runs as its own process, so it takes every
// option, and a flag's spelling too. A metadata mapper without `metadata` is refused
// (checkMapper).
func mergedGroups(own string, g Groups, transfer bool) (config, filter options, err error) {
	read := g.transferGroup
	if !transfer {
		read = func(name string, _ ...string) (options, error) { return decodeGroup(name, g.named(name)) }
	}
	config = options{}
	if own != "" {
		o, err := read(own, blockMain)
		if err != nil {
			return nil, nil, err
		}
		maps.Copy(config, o)
	}
	c, err := read(GroupConfig, blockMain)
	if err != nil {
		return nil, nil, err
	}
	maps.Copy(config, c)
	if filter, err = read(GroupFilter, blockFilter); err != nil {
		return nil, nil, err
	}
	metadata, err := read(GroupMetadata, blockMain, blockFilter)
	if err != nil {
		return nil, nil, err
	}
	for name, v := range metadata {
		if isFilterOption(name) {
			filter[name] = v
		} else {
			config[name] = v
		}
	}
	if err := checkMapper(config); err != nil {
		return nil, nil, err
	}
	return config, filter, nil
}

// settings holds what an operation's plan runs with: its options in the form that the plan
// stores them, and the overrides from the remotes group for its Fs strings.
type settings struct {
	config, filter Options
	remotes        remoteOverrides
}

// transferSettings returns the settings of an operation that reads the filter and metadata
// groups. own is the operation's own group, or "" if it has none.
func transferSettings(own string, g Groups) (settings, error) {
	config, filter, err := mergedGroups(own, g, true)
	if err != nil {
		return settings{}, err
	}
	return storedSettings(g, config, filter)
}

// configSettings returns the settings of a purge, a download or a save. These read only the
// config group, with no filters and no metadata group. A metadata mapper in the config group
// still needs `metadata` (checkMapper).
func configSettings(g Groups) (settings, error) {
	config, err := g.transferGroup(GroupConfig, blockMain)
	if err != nil {
		return settings{}, err
	}
	if err := checkMapper(config); err != nil {
		return settings{}, err
	}
	return storedSettings(g, config, nil)
}

func storedSettings(g Groups, config, filter options) (settings, error) {
	var s settings
	var err error
	if s.config, err = storedOptions(blockMain, config); err != nil {
		return settings{}, err
	}
	if s.filter, err = storedOptions(blockFilter, filter); err != nil {
		return settings{}, err
	}
	if s.remotes, err = g.remotes(); err != nil {
		return settings{}, err
	}
	return s, nil
}

func (s settings) plan(steps []Step) Plan {
	return Plan{V: PlanVersion, Steps: steps, Config: s.config, Filter: s.filter}
}

// fs returns the Fs string for rel below the root of at, with the remote's overrides. The
// overrides are checked against the remote's backend first, because this process opens a plan's
// Fs strings itself.
func (s settings) fs(at location.Fs, rel string) (string, error) {
	overrides := s.remotes[at.Name]
	if err := checkOverrides(at, overrides); err != nil {
		return "", err
	}
	return fsString(at, rel, overrides)
}

func checkIncludeRules(sources []string, filter Options) error {
	_, include := filter["include"]
	_, includeFrom := filter["include_from"]
	if len(sources) > 1 && (include || includeFrom) {
		return errs.New("Include rules are not supported with multiple sources")
	}
	return nil
}

func checkFolderFilters(sources []string, filter Options, k Kinds) error {
	if len(filter) == 0 {
		return nil
	}
	for _, s := range sources {
		if kindOf(s, k) != KindFolder {
			return errs.New("Filters are only supported when every selected source is a folder")
		}
	}
	return nil
}

// sourceKey identifies a source by the root that rclone opens and the path below it, however
// the source is written. A trailing slash doesn't matter, so `gdrive:a` and `gdrive:a/` are the
// same source.
func sourceKey(src location.Fs) string { return src.Root() + "\x00" + src.Rel }

// isInsideAFolderSource reports whether source is inside a folder that is also a source,
// however either one is written. That means rclone opens the same root for both, and the
// source's path is below the folder's path. A root contains everything below it. For example,
// `gdrive:` contains `gdrive:file.txt`, and `/tmp` contains `:local:/tmp/x`. A folder is not
// inside itself.
func isInsideAFolderSource(source location.Fs, folders []location.Fs) bool {
	for _, f := range folders {
		if f.Root() == source.Root() && f.Rel != source.Rel && strings.HasPrefix(source.Rel, f.Dir()) {
			return true
		}
	}
	return false
}

// claimed is a source that writes an entry in the destination: its path as given and its name.
type claimed struct{ source, name string }

// claim records that source writes an entry with its base name in the destination. The name is
// folded the way a case-insensitive store would fold it, and its Unicode is composed. A second
// source with the same name is refused, because a copy would keep only one of them, and a move
// would delete both sources but keep only one. The destination is never opened here, so the case
// is folded for every backend. move selects the advice in the error: move the sources separately,
// or copy them separately.
func claim(names map[string]claimed, src location.Fs, source string, dst location.Fs, move bool) error {
	base := norm.NFC.String(src.Base())
	key := strings.ToLower(base)
	other, taken := names[key]
	if !taken {
		names[key] = claimed{source, base}
		return nil
	}
	target := dst.Entry(dst.Dir() + src.Base())
	switch {
	case other.name != base && move:
		// i18n: Two sources, then the path in the destination that both would get.
		return errs.Errorf("%s and %s would both go to %s. Their names differ only in case, which a provider that ignores case treats as one name. Move them separately.",
			other.source, source, target)
	case other.name != base:
		// i18n: Two sources, then the path in the destination that both would get.
		return errs.Errorf("%s and %s would both go to %s. Their names differ only in case, which a provider that ignores case treats as one name. Copy them separately.",
			other.source, source, target)
	case move:
		// i18n: Two sources, then the path in the destination that both would get.
		return errs.Errorf("%s and %s would both go to %s. Move them separately.", other.source, source, target)
	}
	// i18n: Two sources, then the path in the destination that both would get.
	return errs.Errorf("%s and %s would both go to %s. Copy them separately.", other.source, source, target)
}

// foldersOf returns the sources that are folders, split into root and path.
func foldersOf(sources []string, k Kinds) []location.Fs {
	var folders []location.Fs
	for _, s := range sources {
		if kindOf(s, k) == KindFolder {
			folders = append(folders, split(s))
		}
	}
	return folders
}

// checkTransfer checks a copy or a move: its paths, and include rules, which work with one source
// only.
func checkTransfer(sources []string, destination string, s settings) error {
	if err := required(len(sources) > 0, destination); err != nil {
		return err
	}
	if err := checkPaths(append(slices.Clone(sources), destination)...); err != nil {
		return err
	}
	return checkIncludeRules(sources, s.filter)
}

// buildTransfer builds a copy or a move with one step per source. It skips repeated sources and
// sources inside a folder source, because they are transferred with their folder. A folder is
// copied into the destination under its own name, and so is a file. Two sources with the same
// name are refused. A root combined with other sources is refused too, because a root's entries
// go straight into the destination.
func buildTransfer(a CopyArgs, s settings, folderOp, fileOp string, k Kinds) (Plan, error) {
	if err := checkFolderFilters(a.Sources, s.filter, k); err != nil {
		return Plan{}, err
	}
	folders := foldersOf(a.Sources, k)
	dst := split(a.Destination)
	var steps []Step
	var landings []Landing
	var roots []string
	// handled holds the sources seen so far, by sourceKey, so `gdrive:a` and `gdrive:a/` count
	// as one. names maps each destination entry to its source (claim).
	handled := map[string]bool{}
	names := map[string]claimed{}
	move := folderOp == OpMove
	for _, source := range a.Sources {
		src := split(source)
		if handled[sourceKey(src)] || isInsideAFolderSource(src, folders) {
			continue
		}
		handled[sourceKey(src)] = true
		folder := kindOf(source, k) == KindFolder
		if src.Rel == "" {
			roots = append(roots, source)
			landings = append(landings, Landing{Source: source, Path: dst.Entry(dst.Rel), Folder: true, Contents: true})
		} else {
			if err := claim(names, src, source, dst, move); err != nil {
				return Plan{}, err
			}
			landings = append(landings, Landing{Source: source, Path: dst.Entry(dst.Dir() + src.Base()), Name: src.Base(), Folder: folder})
		}
		if folder {
			srcFs, err := s.fs(src, src.Dir())
			if err != nil {
				return Plan{}, err
			}
			dstFs, err := s.fs(dst, dst.Dir()+src.Base())
			if err != nil {
				return Plan{}, err
			}
			steps = append(steps, Step{Op: folderOp, Src: srcFs, Dst: dstFs, CreateEmptySrcDirs: true})
			continue
		}
		srcFs, err := s.fs(src, "")
		if err != nil {
			return Plan{}, err
		}
		dstFs, err := s.fs(dst, "")
		if err != nil {
			return Plan{}, err
		}
		steps = append(steps, Step{
			Op: fileOp, Src: srcFs, SrcRemote: src.Rel, Dst: dstFs, DstRemote: dst.Dir() + src.Base(),
		})
	}
	// A root has no name of its own to claim, and its entries could collide with the other
	// sources in the destination.
	if len(roots) > 0 && len(steps) > 1 {
		return Plan{}, errs.Errorf("%s is a root: everything in it goes straight into %s, so it can’t be combined with other sources.",
			roots[0], a.Destination)
	}
	p := s.plan(steps)
	p.Landings = landings
	return p, nil
}

func buildCopy(a CopyArgs, s settings, k Kinds) (Plan, error) {
	return buildTransfer(a, s, OpCopy, OpCopyFile, k)
}

func buildMove(a MoveArgs, s settings, k Kinds) (Plan, error) {
	return buildTransfer(CopyArgs(a), s, OpMove, OpMoveFile, k)
}

// checkFolderSource refuses a source that rclone reported as a file when op (a sync or a bisync)
// needs a folder.
func checkFolderSource(source string, k Kinds, op string) error {
	if k == nil || kindOf(source, k) == KindFolder {
		return nil
	}
	if op == OpBisync {
		return errs.Errorf("%s is a file; a bisync needs two folders", source)
	}
	return errs.Errorf("%s is a file; a sync needs a folder", source)
}

// checkTwoPaths checks the paths of a sync, a bisync or a save, which go from one source to one
// destination.
func checkTwoPaths(source, destination string) error {
	if err := required(source != "", destination); err != nil {
		return err
	}
	return checkPaths(source, destination)
}

// twoFolders returns the pair of Fs strings for a sync or a bisync.
func twoFolders(source, destination string, s settings) (string, string, error) {
	from, to := split(source), split(destination)
	src, err := s.fs(from, from.Dir())
	if err != nil {
		return "", "", err
	}
	dst, err := s.fs(to, to.Dir())
	if err != nil {
		return "", "", err
	}
	return src, dst, nil
}

func buildSync(a SyncArgs, s settings, k Kinds) (Plan, error) {
	if err := checkFolderSource(a.Source, k, OpSync); err != nil {
		return Plan{}, err
	}
	src, dst, err := twoFolders(a.Source, a.Destination, s)
	if err != nil {
		return Plan{}, err
	}
	return s.plan([]Step{{Op: OpSync, Src: src, Dst: dst, CreateEmptySrcDirs: true}}), nil
}

// defaultMaxDelete is bisync's own default share of a side's files, in percent, that one run may
// delete (cmd/bisync DefaultMaxDelete).
const defaultMaxDelete = 50

// bisyncParams lists the parameters of sync/bisync (cmd/bisync/rc.go), which are the JSON names of
// BisyncSwitches. These are the only names that a plan's Bisync may contain.
var bisyncParams = func() []string {
	var names []string
	for _, f := range reflect.VisibleFields(reflect.TypeFor[BisyncSwitches]()) {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		names = append(names, name)
	}
	return names
}()

// params returns the switches that are on as sync/bisync's parameters, keyed by their JSON names.
func (s BisyncSwitches) params() map[string]any {
	params := map[string]any{}
	v := reflect.ValueOf(s)
	for i, f := range reflect.VisibleFields(v.Type()) {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		switch field := v.Field(i); field.Kind() {
		case reflect.Bool:
			if field.Bool() {
				params[name] = true
			}
		case reflect.String:
			if field.String() != "" {
				params[name] = field.String()
			}
		case reflect.Pointer:
			if !field.IsNil() {
				params[name] = field.Elem().Interface()
			}
		}
	}
	return params
}

// UnattendedBisync returns the switches s set up to run with nobody watching, as rclone's docs
// advise for a bisync that runs by itself: resilient, recover, and a lock that expires. The
// switches that only make sense for a run that someone started (resync, force and dry run) are
// turned off. merge makes the run a merge of the two folders, newer wins, which deletes nothing.
// workdir, when it isn't "", is where bisync keeps its listings.
func UnattendedBisync(s BisyncSwitches, merge bool, workdir string) BisyncSwitches {
	s.Resync, s.Force, s.DryRun, s.ResyncMode = false, false, false, ""
	s.Resilient, s.Recover, s.MaxLock = true, true, "2m"
	if merge {
		s.Resync, s.ResyncMode = true, "newer"
	}
	if workdir != "" {
		s.Workdir = workdir
	}
	return s
}

func buildBisync(a BisyncArgs, s settings, k Kinds) (Plan, error) {
	if err := checkFolderSource(a.Source, k, OpBisync); err != nil {
		return Plan{}, err
	}
	path1, path2, err := twoFolders(a.Source, a.Destination, s)
	if err != nil {
		return Plan{}, err
	}
	var params map[string]any
	if a.Options.Outer != nil {
		params = a.Options.Outer.params()
	} else {
		params = map[string]any{}
	}
	// sync/bisync over rc leaves maxDelete at 0% when it isn't given, unlike the command line's
	// 50%, so a single delete would stop every bisync. The command line's default applies here.
	if _, ok := params["maxDelete"]; !ok {
		params["maxDelete"] = defaultMaxDelete
	}
	p := s.plan([]Step{{Op: OpBisync, Src: path1, Dst: path2}})
	p.Bisync = params
	return p, nil
}

// checkDeleted checks the paths of a delete or a purge. Only what is inside a remote or a disk is
// deleted, never its root, so a slip in the path can't empty a whole remote.
func checkDeleted(sources []string) error {
	if len(sources) == 0 {
		return errs.New("Please select a source path")
	}
	if err := checkPaths(sources...); err != nil {
		return err
	}
	for _, source := range sources {
		if split(source).Rel == "" {
			return errs.Errorf("%s is the root of a remote. Choose the folders inside it.", source)
		}
	}
	return nil
}

// buildDelete builds a delete. Each folder gets operations.Delete, which deletes its files with
// the filter applied, and each file gets DeleteFile. Repeated sources and sources inside a folder
// source are skipped, because the folder's step deletes them. A separate step would race the
// folder's step and fail on files that it had already deleted.
func buildDelete(a DeleteArgs, s settings, k Kinds) (Plan, error) {
	if err := checkFolderFilters(a.Sources, s.filter, k); err != nil {
		return Plan{}, err
	}
	folders := foldersOf(a.Sources, k)
	var steps []Step
	handled := map[string]bool{} // by sourceKey: `gdrive:a` and `gdrive:a/` are one
	for _, source := range a.Sources {
		src := split(source)
		if handled[sourceKey(src)] || isInsideAFolderSource(src, folders) {
			continue
		}
		handled[sourceKey(src)] = true
		if kindOf(source, k) == KindFolder {
			f, err := s.fs(src, src.Path())
			if err != nil {
				return Plan{}, err
			}
			steps = append(steps, Step{Op: OpDelete, Src: f})
			continue
		}
		root, err := s.fs(src, "")
		if err != nil {
			return Plan{}, err
		}
		steps = append(steps, Step{Op: OpDeleteFile, Src: root, SrcRemote: src.Rel})
	}
	return s.plan(steps), nil
}

// buildPurge builds a purge: operations.Purge on each folder. Only folders are accepted. The
// check hook has already refused the root of a remote or a disk (checkDeleted). As in
// buildDelete, repeated sources and folders inside another source are skipped.
func buildPurge(a PurgeArgs, s settings, k Kinds) (Plan, error) {
	folders := foldersOf(a.Sources, k)
	var steps []Step
	handled := map[string]bool{}
	for _, source := range a.Sources {
		if kindOf(source, k) != KindFolder {
			return Plan{}, errs.Errorf("%s is a file; only folders can be purged", source)
		}
		src := split(source)
		if handled[sourceKey(src)] || isInsideAFolderSource(src, folders) {
			continue
		}
		handled[sourceKey(src)] = true
		root, err := s.fs(src, "")
		if err != nil {
			return Plan{}, err
		}
		steps = append(steps, Step{Op: OpPurge, Src: root, SrcRemote: src.Rel})
	}
	return s.plan(steps), nil
}

func checkDownload(a DownloadArgs) error {
	switch {
	case a.URL == "":
		return errs.New("Please enter a URL")
	case a.Destination == "":
		return errs.New("Please select a destination path")
	case a.Filename == "":
		return errs.New("Please enter a filename")
	}
	// The file name must name a file directly in the folder, as Target reports it, and not a
	// path below or above it.
	if err := checkName(a.Filename); err != nil {
		return err
	}
	return checkPaths(a.Destination)
}

func buildDownload(a DownloadArgs, s settings) (Plan, error) {
	to := split(a.Destination)
	dst, err := s.fs(to, to.Path())
	if err != nil {
		return Plan{}, err
	}
	return s.plan([]Step{{Op: OpCopyURL, Dst: dst, DstRemote: a.Filename, URL: a.URL}}), nil
}

// Target returns the path of the downloaded file, as the transfer's record shows it. The root is
// written the same way as in the destination folder.
func (a DownloadArgs) Target() string {
	at, err := location.Split(a.Destination)
	if err != nil {
		return a.Destination
	}
	return at.Entry(at.Dir() + a.Filename)
}

// buildSave builds the Commander's save to this computer. It copies a folder, including its
// empty folders, or a file, to the full path that the user chose.
func buildSave(a SaveArgs, s settings, k Kinds) (Plan, error) {
	src, dst := split(a.Source), split(a.Destination)
	if kindOf(a.Source, k) == KindFolder {
		srcFs, err := s.fs(src, src.Dir())
		if err != nil {
			return Plan{}, err
		}
		dstFs, err := s.fs(dst, dst.Rel)
		if err != nil {
			return Plan{}, err
		}
		return s.plan([]Step{{Op: OpCopy, Src: srcFs, Dst: dstFs, CreateEmptySrcDirs: true}}), nil
	}
	srcRoot, err := s.fs(src, "")
	if err != nil {
		return Plan{}, err
	}
	dstRoot, err := s.fs(dst, "")
	if err != nil {
		return Plan{}, err
	}
	return s.plan([]Step{{
		Op: OpCopyFile, Src: srcRoot, SrcRemote: src.Rel, Dst: dstRoot, DstRemote: dst.Rel,
	}}), nil
}

// RenameItem is one entry that the Browser renames in place.
type RenameItem struct {
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	NewName string `json:"newName"`
}

// Target returns the Fs and the remote that an item is renamed to. It is used for the collision
// check (a stat) before the rename, because a move silently overwrites or merges into an
// existing entry.
func (it RenameItem) Target() (fs, remote string, err error) {
	if err := checkPaths(it.Path); err != nil {
		return "", "", err
	}
	if err := checkName(it.NewName); err != nil {
		return "", "", err
	}
	at := split(it.Path)
	return at.Root(), renamedRel(at, it.NewName), nil
}

// checkName refuses a new name that doesn't name a single entry in its folder: an empty name, a
// name with a separator, or . or ..
func checkName(name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return errs.New("Name cannot be empty")
	case strings.ContainsAny(name, `/\`), name == ".", name == "..":
		return errs.New("A name cannot contain / or \\")
	}
	return nil
}

// renamedRel returns the path, below the root of at, of the entry at after it is renamed to name
// in the same folder.
func renamedRel(at location.Fs, name string) string {
	dir, _ := path.Split(at.Rel)
	return dir + name
}

func checkRename(items []RenameItem) error {
	if len(items) == 0 {
		return errs.New("Nothing to rename")
	}
	for _, it := range items {
		if _, _, err := it.Target(); err != nil {
			return err
		}
	}
	return nil
}

// buildRename builds the Browser's rename of one or more entries as a single recorded transfer.
// Each file is moved with MoveFile. Each folder is moved to its new name with sync.MoveDir, which
// uses the backend's own directory move when there is one. The steps run one at a time, because
// the batch rename's collision checks assume that.
//
// The collision checks run before the transfer starts. ignore_existing stops every step from
// replacing an entry that appeared after the check, and this includes a retried step, which keeps
// the plan's config. A file step whose new name was taken that way fails (Step.Rename). A folder
// step whose new name was taken merges into that folder, without replacing its files. A case-only
// rename doesn't read ignore_existing, because its moves use operations.MoveCaseInsensitive and a
// directory move.
func buildRename(items []RenameItem) (Plan, error) {
	steps := make([]Step, 0, len(items))
	for _, it := range items {
		root, dstRemote, err := it.Target()
		if err != nil {
			return Plan{}, err
		}
		at := split(it.Path)
		if it.IsDir {
			src, _ := fsString(at, at.Dir(), nil)
			dst, _ := fsString(at, dstRemote+"/", nil)
			// Both switches, so that a folder moved file by file (on a backend without a folder
			// move of its own) keeps its empty subfolders and leaves none behind. rclone leaves
			// the old folder itself, which the step removes (Step.Rename).
			steps = append(steps, Step{Op: OpMove, Src: src, Dst: dst, CreateEmptySrcDirs: true, DeleteEmptySrcDirs: true, Rename: true})
		} else {
			steps = append(steps, Step{
				Op: OpMoveFile, Src: root, SrcRemote: at.Rel, Dst: root, DstRemote: dstRemote, Rename: true,
			})
		}
	}
	return Plan{V: PlanVersion, Steps: steps, Config: Options{"ignore_existing": "true"}, Concurrency: 1}, nil
}

// checkFolderDelete checks the Browser's deletion of a folder, which is never a root.
func checkFolderDelete(p string) error {
	if err := checkPaths(p); err != nil {
		return err
	}
	if split(p).Rel == "" {
		return errs.New("A remote’s root cannot be deleted here")
	}
	return nil
}

func buildFolderDelete(p string) (Plan, error) {
	at := split(p)
	return Plan{V: PlanVersion, Steps: []Step{{Op: OpPurge, Src: at.Root(), SrcRemote: at.Rel}}}, nil
}

func checkCleanup(remote string) error {
	if strings.TrimSpace(remote) == "" {
		return errs.New("Please choose a remote to clean up")
	}
	return checkPaths(remote)
}

func buildCleanup(remote string) (Plan, error) {
	return Plan{V: PlanVersion, Steps: []Step{{Op: OpCleanup, Src: split(remote).Root()}}}, nil
}
