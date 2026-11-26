package children

import (
	"cmp"
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

const goneWait = 5 * time.Second

type LeftoverOptions struct {
	RunDir     string
	SocketDir  string
	Automounts []string

	unmount func(ctx context.Context, mountPoint string) error
	kill    func(pid int) error
}

type Leftovers struct {
	Killed  []Record
	Cleared []string
	Restore []Record
}

func ClearLeftovers(ctx context.Context, o LeftoverOptions) Leftovers {
	log := logs.Logger(logs.CompChildren, logs.SubSupervisor)
	recs, err := readRecords(o.RunDir)
	if err != nil {
		log.ErrorContext(ctx, "could not read the previous run's children; none are cleared", "error", err)
		recs = nil
	}
	kill := o.kill
	if kill == nil {
		kill = killLeftover
	}
	var lo Leftovers
	alive := map[string]bool{}
	for _, r := range recs {
		if r.PID <= 0 || r.StartTime == 0 {
			continue
		}
		if st, err := processStartTime(r.PID); err != nil || st != r.StartTime {
			continue
		}
		if err := kill(r.PID); err != nil {
			log.WarnContext(ctx, "could not kill a child the previous run left", "child", r.Name, "pid", r.PID, "error", err)
			alive[r.ID] = true
			continue
		}
		if !waitGone(ctx, r.PID, r.StartTime) {
			log.WarnContext(ctx, "a child the previous run left is still running after it was killed", "child", r.Name, "pid", r.PID, "waited", goneWait)
			alive[r.ID] = true
			continue
		}
		log.WarnContext(ctx, "killed a child the previous run left", "child", r.Name, "pid", r.PID, "kind", r.Kind)
		lo.Killed = append(lo.Killed, r)
	}

	unmount := o.unmount
	if unmount == nil {
		unmount = Unmount
	}
	for _, mp := range brokenMounts(ctx, recs, o.Automounts) {
		if err := unmount(ctx, mp); err != nil {
			log.ErrorContext(ctx, "could not clear a broken mount point", "mount_point", mp, "error", err)
			continue
		}
		log.InfoContext(ctx, "cleared a broken mount point", "mount_point", mp)
		lo.Cleared = append(lo.Cleared, mp)
	}

	sockets := cmp.Or(o.SocketDir, o.RunDir)
	if err := SweepSockets(sockets); err != nil {
		log.WarnContext(ctx, "could not sweep the children's sockets", "dir", sockets, "error", err)
	}

	for _, r := range recs {
		running := r.PID > 0 && !r.Stopping
		if r.restorable() && validID(r.ID) && !alive[r.ID] && (running || r.Restore) {
			r.PID, r.StartTime, r.Restore, r.Stopping = 0, 0, true, false
			lo.Restore = append(lo.Restore, r)
		}
	}
	return lo
}

func SweepSockets(dir string) error {
	var errs []error
	for _, pattern := range []string{"c-*.sock", "key-*"} {
		matches, err := filepath.Glob(filepath.Join(dir, pattern))
		if err != nil {
			return err
		}
		for _, m := range matches {
			if err := os.Remove(m); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func waitGone(ctx context.Context, pid int, startTime int64) bool {
	deadline := time.Now().Add(goneWait)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if st, err := processStartTime(pid); err != nil || st != startTime {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	st, err := processStartTime(pid)
	return err != nil || st != startTime
}
