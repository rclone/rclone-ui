package rclone

import (
	"context"
	"errors"

	"github.com/rclone/rclone/fs"
)

// errFirstPage stops a listing after the first page.
var errFirstPage = errors.New("rclone: the first page is enough")

// FirstPage lists dir in f up to the end of the first page. A remote or folder that returns
// that much exists, which is enough for a health check or for checking a mount's source at
// start. A paged backend (ListP) stops after the first page, and nothing reads a modtime or a
// type, which would cost a request per object on s3 or swift. Other backends return the whole
// listing in one call.
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
