package operations

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

// Operation names an operation that the app runs. A transfer records the operation that it was
// built for, or the one that it is recorded as (RecordedOperation).
type Operation string

const (
	OperationCopy     Operation = "copy"
	OperationMove     Operation = "move"
	OperationSync     Operation = "sync"
	OperationBisync   Operation = "bisync"
	OperationDelete   Operation = "delete"
	OperationPurge    Operation = "purge"
	OperationDownload Operation = "download"
	// OperationSave is a save from the Commander to this computer, recorded as a download.
	OperationSave Operation = "save"
	// OperationRename is a rename in the Commander, recorded as a move.
	OperationRename Operation = "rename"
	// OperationDeleteFolder is a folder's deletion in the Commander, recorded as a purge.
	OperationDeleteFolder Operation = "delete-folder"
	// OperationCleanup empties a remote's trash, from the launcher.
	OperationCleanup Operation = "cleanup"
	// OperationMount and OperationServe run as children of their own. A form of theirs is only
	// a preset, which opens their page.
	OperationMount Operation = "mount"
	OperationServe Operation = "serve"
)

// Form is an operation and its arguments. Only the field of the operation is set, or none for
// an operation's empty form. The fields are separate, rather than one field of an interface type,
// so that the pages get a type for each operation's arguments.
type Form struct {
	Operation    Operation     `json:"operation"`
	Copy         *CopyArgs     `json:"copy,omitempty"`
	Move         *MoveArgs     `json:"move,omitempty"`
	Sync         *SyncArgs     `json:"sync,omitempty"`
	Bisync       *BisyncArgs   `json:"bisync,omitempty"`
	Delete       *DeleteArgs   `json:"delete,omitempty"`
	Purge        *PurgeArgs    `json:"purge,omitempty"`
	Download     *DownloadArgs `json:"download,omitempty"`
	Save         *SaveArgs     `json:"save,omitempty"`
	Rename       *RenameArgs   `json:"rename,omitempty"`
	DeleteFolder *FolderArgs   `json:"deleteFolder,omitempty"`
	Cleanup      *CleanupArgs  `json:"cleanup,omitempty"`
	// Mount and Serve are only read from a preset. BuildPlan refuses them.
	Mount *MountArgs `json:"mount,omitempty"`
	Serve *ServeArgs `json:"serve,omitempty"`
}

type args interface {
	// paths returns the paths that rclone opens as an Fs. They are checked before rclone is
	// asked anything about them.
	paths() []string
	// ends returns the sources and destination shown on the transfer. The sources are also the
	// paths that describeSources asks rclone about.
	ends() (sources []string, destination string)
	// groups returns the option groups, or nil for a form without options.
	groups() *Groups
	// pathFields returns the fields that hold a path, so that a remote's rename can rewrite
	// them.
	pathFields() []*string
}

// argsOf is satisfied by a pointer to an arguments type.
type argsOf[A any] interface {
	*A
	args
}

// slot is an operation's field of Form.
type slot struct {
	// live returns the field's arguments, or nil when the field is not set. Changing them
	// changes the form.
	live func(f *Form) args
	// copy returns a copy of the field's arguments, or nil when the field is not set. The copy
	// shares the option groups with the form.
	copy func(f *Form) args
	// fresh sets the field to empty arguments and returns them, for decoding into.
	fresh func(f *Form) args
}

// slotOf returns the slot of the field that field points to.
func slotOf[A any, P argsOf[A]](field func(*Form) **A) slot {
	return slot{
		live: func(f *Form) args {
			if p := *field(f); p != nil {
				return P(p)
			}
			return nil
		},
		copy: func(f *Form) args {
			p := *field(f)
			if p == nil {
				return nil
			}
			c := *p
			return P(&c)
		},
		fresh: func(f *Form) args {
			p := new(A)
			*field(f) = p
			return P(p)
		},
	}
}

// slots holds the field of each operation, in the order of Form's fields.
var slots = []struct {
	op Operation
	slot
}{
	{OperationCopy, slotOf(func(f *Form) **CopyArgs { return &f.Copy })},
	{OperationMove, slotOf(func(f *Form) **MoveArgs { return &f.Move })},
	{OperationSync, slotOf(func(f *Form) **SyncArgs { return &f.Sync })},
	{OperationBisync, slotOf(func(f *Form) **BisyncArgs { return &f.Bisync })},
	{OperationDelete, slotOf(func(f *Form) **DeleteArgs { return &f.Delete })},
	{OperationPurge, slotOf(func(f *Form) **PurgeArgs { return &f.Purge })},
	{OperationDownload, slotOf(func(f *Form) **DownloadArgs { return &f.Download })},
	{OperationSave, slotOf(func(f *Form) **SaveArgs { return &f.Save })},
	{OperationRename, slotOf(func(f *Form) **RenameArgs { return &f.Rename })},
	{OperationDeleteFolder, slotOf(func(f *Form) **FolderArgs { return &f.DeleteFolder })},
	{OperationCleanup, slotOf(func(f *Form) **CleanupArgs { return &f.Cleanup })},
	{OperationMount, slotOf(func(f *Form) **MountArgs { return &f.Mount })},
	{OperationServe, slotOf(func(f *Form) **ServeArgs { return &f.Serve })},
}

func slotFor(op Operation) (slot, bool) {
	for _, s := range slots {
		if s.op == op {
			return s.slot, true
		}
	}
	return slot{}, false
}

// args returns a copy of the form's arguments, or empty arguments when its field is not set. It
// refuses an unknown operation, and a form with the field of another operation set, because the
// page would have meant something that doesn't run.
func (f Form) args() (args, error) {
	own, ok := slotFor(f.Operation)
	if !ok {
		return nil, fmt.Errorf("unknown operation %q", f.Operation)
	}
	for _, s := range slots {
		if s.op != f.Operation && s.live(&f) != nil {
			return nil, fmt.Errorf("a %s form with the arguments of a %s", f.Operation, s.op)
		}
	}
	if a := own.copy(&f); a != nil {
		return a, nil
	}
	return own.fresh(&f), nil
}

// Check returns an error when the form's operation is unknown, or when it holds the arguments of
// another operation.
func (f Form) Check() error {
	_, err := f.args()
	return err
}

// MarshalArgs returns the form's arguments as JSON, which is how a transfer and a schedule store
// them. DecodeForm reads them back.
func (f Form) MarshalArgs() (json.RawMessage, error) {
	a, err := f.args()
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(a); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// DecodeForm returns the form of op with the arguments that MarshalArgs wrote. A field that the
// operation's arguments don't have is refused, so a form never runs without part of what it
// asked for.
func DecodeForm(op Operation, raw json.RawMessage) (Form, error) {
	s, ok := slotFor(op)
	if !ok {
		return Form{}, fmt.Errorf("unknown operation %q", op)
	}
	f := Form{Operation: op}
	a := s.fresh(&f)
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return f, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(a); err != nil {
		return Form{}, errs.Errorf("The %s form can’t be read: %v", op, err)
	}
	return f, nil
}

// Ends returns the sources and destination shown on a transfer of the form. It returns nothing
// for a form that args refuses.
func (f Form) Ends() (sources []string, destination string) {
	a, err := f.args()
	if err != nil {
		return nil, ""
	}
	return a.ends()
}

// Groups returns the option groups of the form's arguments, or nil when f is nil, when the
// operation has none, or when its field is not set. Changing them changes the form.
func (f *Form) Groups() *Groups {
	if f == nil {
		return nil
	}
	s, ok := slotFor(f.Operation)
	if !ok {
		return nil
	}
	a := s.live(f)
	if a == nil {
		return nil
	}
	return a.groups()
}

// RenameRemote rewrites the form after the remote from is renamed to to: its paths, the option
// values that name a path on the remote, the keys of the remotes group, and bisync's outer backup
// folders. It changes the form in place, and reports whether anything changed, and whether the
// paths did.
func (f *Form) RenameRemote(from, to string) (changed, paths bool) {
	s, ok := slotFor(f.Operation)
	if !ok {
		return false, false
	}
	a := s.live(f)
	if a == nil {
		return false, false
	}
	for _, p := range a.pathFields() {
		if renamed, ok := location.RenameRemote(*p, from, to); ok {
			*p = renamed
			changed, paths = true, true
		}
	}
	if g := a.groups(); g != nil && g.renameRemote(from, to) {
		changed = true
	}
	return changed, paths
}

// Form returns the arguments as a form of their operation. There is one for each arguments type.
func (a CopyArgs) Form() Form { return Form{Operation: OperationCopy, Copy: &a} }

func (a MoveArgs) Form() Form { return Form{Operation: OperationMove, Move: &a} }

func (a SyncArgs) Form() Form { return Form{Operation: OperationSync, Sync: &a} }

func (a BisyncArgs) Form() Form { return Form{Operation: OperationBisync, Bisync: &a} }

func (a DeleteArgs) Form() Form { return Form{Operation: OperationDelete, Delete: &a} }

func (a PurgeArgs) Form() Form { return Form{Operation: OperationPurge, Purge: &a} }

func (a DownloadArgs) Form() Form { return Form{Operation: OperationDownload, Download: &a} }

func (a SaveArgs) Form() Form { return Form{Operation: OperationSave, Save: &a} }

func (a RenameArgs) Form() Form { return Form{Operation: OperationRename, Rename: &a} }

func (a FolderArgs) Form() Form { return Form{Operation: OperationDeleteFolder, DeleteFolder: &a} }

func (a CleanupArgs) Form() Form { return Form{Operation: OperationCleanup, Cleanup: &a} }

func (a MountArgs) Form() Form { return Form{Operation: OperationMount, Mount: &a} }

func (a ServeArgs) Form() Form { return Form{Operation: OperationServe, Serve: &a} }
