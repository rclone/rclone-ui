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

const sizesAtOnce = 2

type Size struct {
	Path    string
	Files   int64
	Bytes   int64
	Partial bool
}

func Sizes(ctx context.Context, paths []string, emit func(Size)) error {
	var todo []string
	opened := map[string]bool{}
	for _, p := range paths {
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
		mu       sync.Mutex
		finished atomic.Int64
		wg       sync.WaitGroup
	)
	// Each folder is counted as its own job in the call's stats group, because rclone can only
	// recover from a fatal error on a goroutine that its job runner started.
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
					return nil
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

func count(ctx context.Context, p string) (Size, error) {
	f, err := getFs(ctx, p)
	if err != nil {
		return Size{Path: p}, err
	}
	files, bytes, _, err := operations.Count(ctx, f)
	return Size{Path: p, Files: files, Bytes: bytes}, err
}
