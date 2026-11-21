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

// goneWait is how long a killed leftover process has to disappear before the broken mounts are
// checked.
const goneWait = 5 * time.Second

type LeftoverOptions struct {
	RunDir    string
	SocketDir string // "" means RunDir
	// Automounts are the mount points of the automounts. Linux also checks the ones
	// that are not recorded.
	Automounts []string

	unmount func(ctx context.Context, mountPoint string) error // for tests; nil means Unmount
	kill    func(pid int) error                                // for tests; nil means killLeftover
}

type Leftovers struct {
	Killed  []Record // processes from a previous run that were still alive and were killed
	Cleared []string // broken mount points that were force-unmounted
	// Restore are the mounts and serves that were running when the previous process ended (a
	// crash), or that a planned restart recorded. They go to the supervisor's Begin, for the
	// mounts service to start again or drop. A record whose process is still alive (because it
	// couldn't be killed) is left out, because a new one would run next to it.
	Restore []Record
}

// ClearLeftovers is the cleanup at start, before any child starts. It kills every process listed
// in children.json that is still alive with the same start time, force-unmounts every broken
// mount point, and removes stale sockets. The records it returns to start again (Restore) go to
// the supervisor's Begin, which writes them back to children.json. An unreadable children.json
// is logged and treated as empty.
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
	alive := map[string]bool{} // ids whose process from the previous run is still running
	for _, r := range recs {
		if r.PID <= 0 || r.StartTime == 0 {
			continue
		}
		if st, err := processStartTime(r.PID); err != nil || st != r.StartTime {
			continue // gone, or the pid now belongs to another program
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
		// A running record comes back when its process ended without being stopped (a crash).
		// One that was being stopped (a quit that ran out of time) does not.
		running := r.PID > 0 && !r.Stopping
		if r.restorable() && validID(r.ID) && !alive[r.ID] && (running || r.Restore) {
			r.PID, r.StartTime, r.Restore, r.Stopping = 0, 0, true, false
			lo.Restore = append(lo.Restore, r)
		}
	}
	return lo
}

// SweepSockets removes every child socket (c-*.sock) and every key file that a child never read
// (key-*) from dir, which is the run dir or the sockets folder. It must only be called when none
// of our children are running.
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

// waitGone waits until pid is no longer the process that started at startTime, and reports
// whether that happened within goneWait.
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
