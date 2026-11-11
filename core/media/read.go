package media

import (
	"context"
	"io"
	"time"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Start is the beginning of a file, as Read returns it.
type Start struct {
	Data []byte
	// Size is the whole file's size, or -1 when the remote doesn't know it.
	Size    int64
	ModTime time.Time
	// Whole is true when Data holds the whole file.
	Whole bool
}

// Read returns the first limit bytes of the file at path, a full path as the panels write it. It
// asks the remote for that part only, so a large file isn't downloaded. Like a stream (serve), it
// runs as an rclone job in its own stats group, so a fatal rclone error while opening the remote
// becomes the read's error.
func Read(ctx context.Context, path string, limit int64) (Start, error) {
	if path == "" {
		return Start{}, errs.Invalid(i18n.M("Name the file."), errs.Violation("path", "missing"))
	}
	if err := location.FieldRefusal("path", path); err != nil {
		return Start{}, err
	}
	limit = max(limit, 0)
	group := rclone.UIGroup("read", ids.New())
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	var out Start
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		o, err := object(ctx, path)
		if err != nil {
			return err
		}
		out = Start{Size: o.Size(), ModTime: o.ModTime(ctx)}
		if out.Size == 0 || limit == 0 {
			// Nothing is read. Some servers refuse a range of an empty file.
			out.Data, out.Whole = []byte{}, out.Size == 0
			return nil
		}
		var options []fs.OpenOption
		if out.Size > limit {
			options = append(options, &fs.RangeOption{Start: 0, End: limit - 1})
		}
		in, err := o.Open(ctx, options...)
		if err != nil {
			return err
		}
		defer func() { _ = in.Close() }()
		// One byte more than limit tells whether a file of unknown size goes on. A backend that
		// ignores the range is cut off here too.
		data, err := io.ReadAll(io.LimitReader(in, limit+1))
		if err != nil {
			return err
		}
		out.Whole = int64(len(data)) <= limit && out.Size <= limit
		out.Data = data[:min(int64(len(data)), limit)]
		return nil
	})
	if err != nil {
		return Start{}, err
	}
	return out, nil
}
