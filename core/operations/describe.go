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

// rclone's stat of a root lists all of it, so only the root's first page is read.
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

type SourceMissingError struct{ Path string }

func (e *SourceMissingError) Error() string { return e.Unwrap().Error() }

func (e *SourceMissingError) Unwrap() error {
	return errs.Errorf("Source does not exist, %s is missing", e.Path)
}
