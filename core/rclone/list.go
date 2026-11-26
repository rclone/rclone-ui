package rclone

import (
	"context"
	"errors"

	"github.com/rclone/rclone/fs"
)

var errFirstPage = errors.New("rclone: the first page is enough")

func FirstPage(ctx context.Context, f fs.Fs, dir string) error {
	if listP := f.Features().ListP; listP != nil {
		err := listP(ctx, dir, func(fs.DirEntries) error { return errFirstPage })
		if errors.Is(err, errFirstPage) {
			return nil
		}
		return err
	}
	_, err := f.List(ctx, dir)
	return err
}
