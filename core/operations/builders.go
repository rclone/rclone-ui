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

type Kind string

const (
	KindFile   Kind = "file"
	KindFolder Kind = "folder"
)

type Kinds map[string]Kind

func kindOf(p string, k Kinds) Kind {
	if kind, ok := k[p]; ok {
		return kind
	}
	if at, err := location.Split(p); err == nil && at.Folder {
		return KindFolder
	}
	return KindFile
}

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

func split(p string) location.Fs {
	at, _ := location.Split(p)
	return at
}

func required(hasSource bool, destination string) error {
	if !hasSource {
		return errs.New("Please select a source path")
	}
	if destination == "" {
		return errs.New("Please select a destination path")
	}
	return nil
}

func isFilterOption(name string) bool {
	_, ok := blockOption(blockFilter, name)
	return ok
}

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

type settings struct {
	config, filter Options
	remotes        remoteOverrides
}

func transferSettings(own string, g Groups) (settings, error) {
	config, filter, err := mergedGroups(own, g, true)
	if err != nil {
		return settings{}, err
	}
	return storedSettings(g, config, filter)
}

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

func sourceKey(src location.Fs) string { return src.Root() + "\x00" + src.Rel }

func isInsideAFolderSource(source location.Fs, folders []location.Fs) bool {
	for _, f := range folders {
		if f.Root() == source.Root() && f.Rel != source.Rel && strings.HasPrefix(source.Rel, f.Dir()) {
			return true
		}
	}
	return false
}

type claimed struct{ source, name string }

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

func foldersOf(sources []string, k Kinds) []location.Fs {
	var folders []location.Fs
	for _, s := range sources {
		if kindOf(s, k) == KindFolder {
			folders = append(folders, split(s))
		}
	}
	return folders
}

func checkTransfer(sources []string, destination string, s settings) error {
	if err := required(len(sources) > 0, destination); err != nil {
		return err
	}
	if err := checkPaths(append(slices.Clone(sources), destination)...); err != nil {
		return err
	}
	return checkIncludeRules(sources, s.filter)
}

func buildTransfer(a CopyArgs, s settings, folderOp, fileOp string, k Kinds) (Plan, error) {
	if err := checkFolderFilters(a.Sources, s.filter, k); err != nil {
		return Plan{}, err
	}
	folders := foldersOf(a.Sources, k)
	dst := split(a.Destination)
	var steps []Step
	var landings []Landing
	var roots []string
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
			steps = append(steps, Step{
				Op: folderOp, Src: srcFs, Dst: dstFs, CreateEmptySrcDirs: true,
				DeleteEmptySrcDirs: move, RemoveSrc: move && src.Rel != "",
			})
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

func checkFolderSource(source string, k Kinds, op string) error {
	if k == nil || kindOf(source, k) == KindFolder {
		return nil
	}
	if op == OpBisync {
		return errs.Errorf("%s is a file; a bisync needs two folders", source)
	}
	return errs.Errorf("%s is a file; a sync needs a folder", source)
}

func checkTwoPaths(source, destination string) error {
	if err := required(source != "", destination); err != nil {
		return err
	}
	return checkPaths(source, destination)
}

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

const defaultMaxDelete = 50

var bisyncParams = func() []string {
	var names []string
	for _, f := range reflect.VisibleFields(reflect.TypeFor[BisyncSwitches]()) {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		names = append(names, name)
	}
	return names
}()

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
	// 50%, so a single delete would stop every bisync.
	if _, ok := params["maxDelete"]; !ok {
		params["maxDelete"] = defaultMaxDelete
	}
	p := s.plan([]Step{{Op: OpBisync, Src: path1, Dst: path2}})
	p.Bisync = params
	return p, nil
}

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

func buildDelete(a DeleteArgs, s settings, k Kinds) (Plan, error) {
	if err := checkFolderFilters(a.Sources, s.filter, k); err != nil {
		return Plan{}, err
	}
	folders := foldersOf(a.Sources, k)
	var steps []Step
	handled := map[string]bool{}
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

func (a DownloadArgs) Target() string {
	at, err := location.Split(a.Destination)
	if err != nil {
		return a.Destination
	}
	return at.Entry(at.Dir() + a.Filename)
}

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

func checkName(name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return errs.New("Name cannot be empty")
	case strings.ContainsAny(name, `/\`), name == ".", name == "..":
		return errs.New("A name cannot contain / or \\")
	}
	return nil
}

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
			steps = append(steps, Step{Op: OpMove, Src: src, Dst: dst, CreateEmptySrcDirs: true, DeleteEmptySrcDirs: true, Rename: true})
		} else {
			steps = append(steps, Step{
				Op: OpMoveFile, Src: root, SrcRemote: at.Rel, Dst: root, DstRemote: dstRemote, Rename: true,
			})
		}
	}
	return Plan{V: PlanVersion, Steps: steps, Config: Options{"ignore_existing": "true"}, Concurrency: 1}, nil
}

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
