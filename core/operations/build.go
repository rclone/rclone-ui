package operations

import (
	"context"
	"fmt"

	"github.com/rclone/rclone-ui/core/location"
)

// RenameArgs holds a rename of one or more entries from the Browser, such as a batch rename
// or the rename of a folder.
type RenameArgs struct {
	Items []RenameItem `json:"items"`
}

// FolderArgs holds the deletion of a folder from the Browser.
type FolderArgs struct {
	Path string `json:"path"`
}

// CleanupArgs holds the launcher's Cleanup action, which empties a remote's trash and removes
// old file versions.
type CleanupArgs struct {
	Remote string `json:"remote"`
}

func (a RenameArgs) paths() []string {
	paths := make([]string, len(a.Items))
	for i, it := range a.Items {
		paths[i] = it.Path
	}
	return paths
}

func (a *RenameArgs) pathFields() []*string {
	out := make([]*string, len(a.Items))
	for i := range a.Items {
		out[i] = &a.Items[i].Path
	}
	return out
}
func (a *FolderArgs) pathFields() []*string  { return []*string{&a.Path} }
func (a *CleanupArgs) pathFields() []*string { return []*string{&a.Remote} }

func (a FolderArgs) paths() []string  { return []string{a.Path} }
func (a CleanupArgs) paths() []string { return []string{a.Remote} }

// BuildPlan builds the plan of a form whose operation is listed in operationSpecs. It checks the
// form as CheckForm does. When the plan depends on whether the sources are files or folders, it
// asks rclone first (describeSources).
func BuildPlan(ctx context.Context, f Form) (Plan, error) {
	spec, a, s, err := checked(f)
	if err != nil {
		return Plan{}, err
	}
	var k Kinds
	if spec.describe {
		sources, _ := a.ends()
		if k, err = describeSources(ctx, sources, s); err != nil {
			return Plan{}, err
		}
	}
	return spec.build(a, s, k)
}

// CheckForm returns why BuildPlan would refuse the form, as far as that can be told without
// asking rclone about the paths. A page calls it as the user types, so the refusal shows before
// the start.
func CheckForm(f Form) error {
	_, _, _, err := checked(f)
	return err
}

// checked reads and checks a form for BuildPlan and CheckForm. It returns the operation's spec, a
// copy of the arguments with the app's defaults added, and the settings that the plan runs with.
func checked(f Form) (operationSpec, args, settings, error) {
	spec, ok := operationSpecs[f.Operation]
	if !ok {
		return operationSpec{}, nil, settings{}, fmt.Errorf("a %q form doesn't run as a transfer", f.Operation)
	}
	a, err := f.args()
	if err != nil {
		return operationSpec{}, nil, settings{}, err
	}
	if err := checkArgs(f.Operation, a); err != nil {
		return operationSpec{}, nil, settings{}, err
	}
	var s settings
	if spec.settings != nil {
		// Check the options first, so rclone is never called with an option it would refuse.
		if s, err = spec.settings(*a.groups()); err != nil {
			return operationSpec{}, nil, settings{}, err
		}
	}
	if err := spec.check(a, s); err != nil {
		return operationSpec{}, nil, settings{}, err
	}
	return spec, a, s, nil
}

// checkArgs checks the paths of a form's arguments, so rclone is never asked about a path it
// would refuse. It then adds the app's default options for op, and stores the app's own metadata
// mapper in the form that the page writes. a is a copy of the form's arguments, and its groups
// are copied before either change, so the form itself doesn't change.
func checkArgs(op Operation, a args) error {
	for _, p := range a.paths() {
		if err := location.Refusal(p); err != nil {
			return err
		}
	}
	g := a.groups()
	if g == nil {
		return nil
	}
	*g = withDefaults(op, *g)
	return StoreMapper(g)
}
