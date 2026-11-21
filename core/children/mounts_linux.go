package children

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// statWait limits the stat of a FUSE mount point, because a daemon that is alive but hung would
// block it.
const statWait = 2 * time.Second

func mountTable() ([]mountEntry, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parseMountinfo(f)
}

// MountPoints lists every mounted folder as /proc/self/mountinfo writes it, without touching
// any of them.
func MountPoints() ([]string, error) {
	entries, err := mountTable()
	if err != nil {
		return nil, err
	}
	points := make([]string, len(entries))
	for i, e := range entries {
		points[i] = e.Point
	}
	return points, nil
}

// Mounted reports whether /proc/self/mountinfo lists mountPoint, without touching the mount
// itself.
func Mounted(mountPoint string) (bool, error) {
	entries, err := mountTable()
	if err != nil {
		return false, err
	}
	clean, resolved := filepath.Clean(mountPoint), resolvedMountPoint(mountPoint)
	for _, e := range entries {
		if e.Point == clean || e.Point == resolved {
			return true, nil
		}
	}
	return false, nil
}

// brokenMounts returns the mount points that ClearLeftovers force-unmounts on Linux. It checks
// every recorded or automount mount point and every fuse.rclone entry, and returns the ones
// that are mounted and whose folder returns ENOTCONN (their FUSE daemon is gone).
func brokenMounts(_ context.Context, recs []Record, automounts []string) []string {
	entries, err := mountTable()
	if err != nil {
		return nil
	}
	mounted := map[string]bool{}
	var candidates []string
	seen := map[string]bool{}
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			candidates = append(candidates, p)
		}
	}
	for _, e := range entries {
		mounted[e.Point] = true
	}
	for _, r := range recs {
		if r.Kind == KindMount && r.MountPoint != "" {
			add(resolvedMountPoint(r.MountPoint))
		}
	}
	for _, mp := range automounts {
		add(resolvedMountPoint(mp))
	}
	for _, e := range entries {
		if e.FSType == "fuse.rclone" {
			add(e.Point)
		}
	}
	var broken []string
	for _, mp := range candidates {
		if mounted[mp] && answersENOTCONN(mp) {
			broken = append(broken, mp)
		}
	}
	return broken
}

func answersENOTCONN(mountPoint string) bool {
	done := make(chan error, 1)
	go func() {
		var st unix.Stat_t
		done <- unix.Stat(mountPoint, &st)
	}()
	select {
	case err := <-done:
		return errors.Is(err, unix.ENOTCONN)
	case <-time.After(statWait):
		return false // alive but slow, so it isn't ours to clear
	}
}
