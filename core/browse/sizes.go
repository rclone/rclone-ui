package browse

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

// sizesAtOnce is how many folders one Sizes call counts at the same time.
const sizesAtOnce = 2

// Size is the content of one folder, counting everything below it.
type Size struct {
	Path  string
	Files int64
	Bytes int64
	// Partial marks counts that are incomplete because the work stopped partway through the folder.
	Partial bool
}

// Sizes counts each folder in paths with operations.Count, two at a time, and emits each result
// when it is done. The paths are rclone paths, as in a listing's rows. A folder that can't be
// counted is left out. When ctx ends, Count stops promptly. The folders being counted then
// report what they had so far, marked Partial, and Sizes returns ctx's error.
func Sizes(ctx context.Context, paths []string, emit func(Size)) error {
	// Each folder's remote is opened here first, on the caller's goroutine, which runs an rclone
	// job. A fatal rclone error while opening the remote can only be recovered there. The
	// folder's own Fs, which a worker opens later, has the same config. A folder whose remote
	// doesn't open has nothing to count, so it is left out like any folder that can't be counted.
	var todo []string
	opened := map[string]bool{}
	for _, p := range paths {
		// Paths that rclone would refuse or misread are left out too, just as a listing refuses
		// them. For example, a relative local path would be counted from the root.
		if !location.Problem(p).IsZero() {
			continue
		}
		at, err := location.Split(p)
		if err != nil {
			continue
		}
		root := at.Root()
		if _, seen := opened[root]; !seen {
			_, err := getFs(ctx, root)
			if err != nil && ctx.Err() != nil {
				return context.Cause(ctx)
			}
			opened[root] = err == nil
		}
		if opened[root] {
			todo = append(todo, p)
		}
	}
	if len(todo) == 0 {
		return nil
	}
	var (
		mu       sync.Mutex // emit is called one at a time
		finished atomic.Int64
		wg       sync.WaitGroup
	)
	// Each folder is counted as its own job in the call's stats group, because rclone can only
	// recover from a fatal error on a goroutine that its job runner started. The job's own error,
	// which is a fatal one, becomes the folder's error.
	group, _ := accounting.StatsGroupFromContext(ctx)
	work := make(chan string)
	for range min(sizesAtOnce, len(todo)) {
		wg.Go(func() {
			for p := range work {
				var (
					s   Size
					err error
				)
				_, jobErr := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
					s, err = count(ctx, p)
					return nil // count's error is kept with its partial counts
				})
				if jobErr != nil {
					s, err = Size{Path: p}, jobErr
				}
				switch {
				case err == nil:
					finished.Add(1)
				case ctx.Err() == nil:
					finished.Add(1)
					continue
				default:
					s.Partial = true
				}
				mu.Lock()
				emit(s)
				mu.Unlock()
			}
		})
	}
feed:
	for _, p := range todo {
		select {
		case work <- p:
		case <-ctx.Done():
			break feed
		}
	}
	close(work)
	wg.Wait()
	if finished.Load() < int64(len(todo)) {
		return context.Cause(ctx)
	}
	return nil
}

// count returns the content of the folder at p, as far as Count got.
func count(ctx context.Context, p string) (Size, error) {
	f, err := getFs(ctx, p)
	if err != nil {
		return Size{Path: p}, err
	}
	files, bytes, _, err := operations.Count(ctx, f)
	return Size{Path: p, Files: files, Bytes: bytes}, err
}
