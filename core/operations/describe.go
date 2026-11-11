package operations

import (
	"context"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	rcops "github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

// describeSources asks rclone whether each source is a file or a folder. It runs one stat
// (operations.StatJSON) per distinct path, in a job of its own, with the settings the plan will
// run with: the main options and the per-remote overrides from the remotes group.
//
// A trailing slash doesn't change the result. A root is always a folder. Only its first page is
// read, because rclone's stat of a root lists all of it, and one page is enough to detect an
// unplugged disk or a missing bucket. When the remote can't be reached, that error is returned
// rather than "does not exist". Empty paths are skipped, because the builders report them as
// missing.
func describeSources(ctx context.Context, paths []string, s settings) (Kinds, error) {
	group := rclone.UIGroup("describe", ids.New())
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	kinds := Kinds{}
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		ctx, ci := fs.AddConfig(ctx)
		if err := setOptions(blockMain, s.config, ci); err != nil {
			return err
		}
		for _, p := range paths {
			if _, done := kinds[p]; done || p == "" {
				continue
			}
			if problem := location.Problem(p); !problem.IsZero() {
				// i18n: A path, then why it can't be used.
				return errs.Errorf("%s: %s", p, problem)
			}
			at := split(p)
			root, err := s.fs(at, "")
			if err != nil {
				return err
			}
			f, err := cache.Get(ctx, root)
			if err != nil {
				return err
			}
			if at.Rel == "" {
				if err := rclone.FirstPage(ctx, f, ""); err != nil {
					return err
				}
				kinds[p] = KindFolder
				continue
			}
			item, err := rcops.StatJSON(ctx, f, at.Rel, &rcops.ListJSONOpt{NoModTime: true, NoMimeType: true})
			if err != nil {
				return err
			}
			if item == nil {
				return &SourceMissingError{Path: p}
			}
			kinds[p] = KindFile
			if item.IsDir {
				kinds[p] = KindFolder
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return kinds, nil
}

// SourceMissingError is the refusal of a start whose source doesn't exist. Path is the source as
// the form gave it. A schedule reads it to drop the sources that a Move, Delete or Purge has
// already removed.
type SourceMissingError struct{ Path string }

func (e *SourceMissingError) Error() string { return e.Unwrap().Error() }

// Unwrap returns the refusal that the user sees. errs.Is finds it, and the shell translates it.
func (e *SourceMissingError) Unwrap() error {
	return errs.Errorf("Source does not exist, %s is missing", e.Path)
}
