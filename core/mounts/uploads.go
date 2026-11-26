package mounts

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/children"
)

const busyWait = 2 * time.Second

// ListUploads works like List, but also reads each running mount's upload queue. It reads all
// queues at once and waits at most busyWait for each.
func (s *Service) ListUploads(ctx context.Context) []Mount {
	all := s.reg.All()
	queues := readQueues(ctx, all)
	out := make([]Mount, len(all))
	for i, c := range all {
		out[i] = s.view(c)
		out[i].UploadsPending = queues[i]
	}
	return out
}

// Busy returns what a quit or an update would stop: every mount in the registry, with its queued
// uploads read now, and whether it comes back after the restart. restore is true for an update,
// whose restart brings every mount back. An automount comes back either way.
func (s *Service) Busy(ctx context.Context, restore bool) []BusyMount {
	automount, _ := s.automountFolders(ctx)
	live := s.reg.Live()
	queues := readQueues(ctx, live)
	out := make([]BusyMount, len(live))
	for i, c := range live {
		_, own := s.reg.View(c)
		out[i] = BusyMount{
			ID:             c.ID,
			Source:         c.Source,
			MountPoint:     own.mountPoint,
			UploadsPending: queues[i],
			Back:           restore || own.automount || automount[filepath.Clean(own.folder)],
		}
	}
	return out
}

func readQueues(ctx context.Context, mounts []*child) []int {
	out := make([]int, len(mounts))
	var wg sync.WaitGroup
	for i, c := range mounts {
		unit := c.Unit()
		if unit == nil || unit.State() != children.StateUp {
			continue
		}
		wg.Go(func() {
			qctx, cancel := context.WithTimeout(ctx, busyWait)
			defer cancel()
			if queue, err := unit.RC().VFSQueue(qctx); err == nil {
				out[i] = len(queue)
			}
		})
	}
	wg.Wait()
	return out
}
