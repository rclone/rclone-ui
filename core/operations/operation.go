package operations

import (
	"github.com/rclone/rclone-ui/core/location"
)

type operationSpec struct {
	settings func(Groups) (settings, error)
	check    func(a args, s settings) error
	describe bool
	build    func(a args, s settings, k Kinds) (Plan, error)
	recorded Operation
}

var operationSpecs = map[Operation]operationSpec{
	OperationCopy: {settings: transferOf(GroupCopy), check: checker(func(a CopyArgs, s settings) error {
		return checkTransfer(a.Sources, a.Destination, s)
	}), describe: true, build: builder(buildCopy)},
	OperationMove: {settings: transferOf(GroupMove), check: checker(func(a MoveArgs, s settings) error {
		return checkTransfer(a.Sources, a.Destination, s)
	}), describe: true, build: builder(buildMove)},
	OperationSync: {settings: transferOf(GroupSync), check: checker(func(a SyncArgs, _ settings) error {
		return checkTwoPaths(a.Source, a.Destination)
	}), describe: true, build: builder(buildSync)},
	OperationBisync: {settings: transferOf(GroupBisync), check: checker(func(a BisyncArgs, _ settings) error {
		return checkTwoPaths(a.Source, a.Destination)
	}), describe: true, build: builder(buildBisync)},
	OperationDelete: {settings: transferOf(""), check: checker(func(a DeleteArgs, s settings) error {
		if err := checkDeleted(a.Sources); err != nil {
			return err
		}
		return checkIncludeRules(a.Sources, s.filter)
	}), describe: true, build: builder(buildDelete)},
	OperationPurge: {settings: configSettings, check: checker(func(a PurgeArgs, _ settings) error {
		return checkDeleted(a.Sources)
	}), describe: true, build: builder(buildPurge)},
	OperationDownload: {settings: configSettings, check: checker(func(a DownloadArgs, _ settings) error {
		return checkDownload(a)
	}), build: builder(func(a DownloadArgs, s settings, _ Kinds) (Plan, error) { return buildDownload(a, s) })},
	OperationSave: {settings: configSettings, check: checker(func(a SaveArgs, _ settings) error {
		return checkTwoPaths(a.Source, a.Destination)
	}), describe: true, build: builder(buildSave), recorded: OperationDownload},
	OperationRename: {recorded: OperationMove, check: checker(func(a RenameArgs, _ settings) error {
		return checkRename(a.Items)
	}), build: builder(func(a RenameArgs, _ settings, _ Kinds) (Plan, error) { return buildRename(a.Items) })},
	OperationDeleteFolder: {recorded: OperationPurge, check: checker(func(a FolderArgs, _ settings) error {
		return checkFolderDelete(a.Path)
	}), build: builder(func(a FolderArgs, _ settings, _ Kinds) (Plan, error) { return buildFolderDelete(a.Path) })},
	OperationCleanup: {check: checker(func(a CleanupArgs, _ settings) error {
		return checkCleanup(a.Remote)
	}), build: builder(func(a CleanupArgs, _ settings, _ Kinds) (Plan, error) { return buildCleanup(a.Remote) })},
}

func checker[A any, P argsOf[A]](check func(A, settings) error) func(args, settings) error {
	return func(a args, s settings) error { return check(*a.(P), s) }
}

func builder[A any, P argsOf[A]](build func(A, settings, Kinds) (Plan, error)) func(args, settings, Kinds) (Plan, error) {
	return func(a args, s settings, k Kinds) (Plan, error) { return build(*a.(P), s, k) }
}

func transferOf(own string) func(Groups) (settings, error) {
	return func(g Groups) (settings, error) { return transferSettings(own, g) }
}

func RecordedOperation(operation Operation) Operation {
	if s := operationSpecs[operation]; s.recorded != "" {
		return s.recorded
	}
	return operation
}

func IsRecordedOperation(operation Operation) bool {
	for name, s := range operationSpecs {
		if operation == name && s.recorded == "" || s.recorded != "" && operation == s.recorded {
			return true
		}
	}
	return false
}

func (a CopyArgs) ends() ([]string, string)     { return a.Sources, a.Destination }
func (a MoveArgs) ends() ([]string, string)     { return a.Sources, a.Destination }
func (a SyncArgs) ends() ([]string, string)     { return []string{a.Source}, a.Destination }
func (a BisyncArgs) ends() ([]string, string)   { return []string{a.Source}, a.Destination }
func (a DeleteArgs) ends() ([]string, string)   { return a.Sources, "" }
func (a PurgeArgs) ends() ([]string, string)    { return a.Sources, "" }
func (a DownloadArgs) ends() ([]string, string) { return []string{a.URL}, a.Target() }
func (a SaveArgs) ends() ([]string, string)     { return []string{a.Source}, a.Destination }
func (a FolderArgs) ends() ([]string, string)   { return []string{a.Path}, "" }
func (a CleanupArgs) ends() ([]string, string)  { return []string{a.Remote}, "" }
func (a MountArgs) ends() ([]string, string)    { return []string{a.Source}, a.Destination }
func (a ServeArgs) ends() ([]string, string)    { return []string{a.Source}, "" }

func (a RenameArgs) ends() ([]string, string) {
	sources := make([]string, len(a.Items))
	for i, it := range a.Items {
		sources[i] = it.Path
	}
	if len(a.Items) != 1 {
		return sources, ""
	}
	at, err := location.Split(a.Items[0].Path)
	if err != nil {
		return sources, ""
	}
	return sources, at.Entry(renamedRel(at, a.Items[0].NewName))
}

func (a *CopyArgs) groups() *Groups     { return &a.Options }
func (a *MoveArgs) groups() *Groups     { return &a.Options }
func (a *SyncArgs) groups() *Groups     { return &a.Options }
func (a *BisyncArgs) groups() *Groups   { return &a.Options }
func (a *DeleteArgs) groups() *Groups   { return &a.Options }
func (a *PurgeArgs) groups() *Groups    { return &a.Options }
func (a *DownloadArgs) groups() *Groups { return &a.Options }
func (a *SaveArgs) groups() *Groups     { return &a.Options }
func (a *MountArgs) groups() *Groups    { return &a.Options }
func (a *ServeArgs) groups() *Groups    { return &a.Options }
func (*RenameArgs) groups() *Groups     { return nil }
func (*FolderArgs) groups() *Groups     { return nil }
func (*CleanupArgs) groups() *Groups    { return nil }
