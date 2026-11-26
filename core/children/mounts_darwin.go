package children

import (
	"context"
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// mountPoints lists the mounted folders with getfsstat(MNT_NOWAIT). It reads the kernel's table
// without querying any filesystem, so a dead NFS mount can't make it hang.
func mountPoints() (map[string]bool, error) {
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	buf := make([]unix.Statfs_t, n+16)
	n, err = unix.Getfsstat(buf, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	points := make(map[string]bool, n)
	for _, st := range buf[:n] {
		points[unix.ByteSliceToString(st.Mntonname[:])] = true
	}
	return points, nil
}

func MountPoints() ([]string, error) {
	points, err := mountPoints()
	if err != nil {
		return nil, err
	}
	return slices.Sorted(maps.Keys(points)), nil
}

func Mounted(mountPoint string) (bool, error) {
	points, err := mountPoints()
	if err != nil {
		return false, err
	}
	_, ok := listed(points, mountPoint)
	return ok, nil
}

// pcCaseSensitive is pathconf's name for whether a volume tells names apart by their case
// (_PC_CASE_SENSITIVE in <unistd.h>).
const pcCaseSensitive = 11

// The table writes a path as the disk has it. Most Macs' volumes ignore case, so a mount point
// typed as ~/Rclone/box, where the folder on disk is ~/rclone, is listed as ~/rclone/box. An
// exact lookup would miss it, and the mount would never count as ready. So when the exact
// spelling isn't listed, an entry that differs only by case counts when it is in the same folder
// on disk, and its own name is the same or the volume ignores case. Only the parent folders are
// looked at: the mount point itself is never touched, because a dead NFS mount would hang.
func listed(points map[string]bool, mountPoint string) (string, bool) {
	mp := resolvedMountPoint(mountPoint)
	if points[mp] {
		return mp, true
	}
	parent, err := os.Stat(filepath.Dir(mp))
	if err != nil {
		return mp, false
	}
	for point := range points {
		if !strings.EqualFold(point, mp) {
			continue
		}
		other, err := os.Stat(filepath.Dir(point))
		if err != nil || !os.SameFile(parent, other) {
			continue
		}
		if filepath.Base(point) == filepath.Base(mp) || ignoresCase(filepath.Dir(mp)) {
			return point, true
		}
	}
	return mp, false
}

func ignoresCase(dir string) bool {
	sensitive, err := unix.Pathconf(dir, pcCaseSensitive)
	return err == nil && sensitive == 0
}

func brokenMounts(ctx context.Context, recs []Record, _ []string) []string {
	points, err := mountPoints()
	if err != nil {
		return nil
	}
	var broken []string
	for _, r := range recs {
		if r.Kind != KindMount || r.MountPoint == "" || r.NFSPort <= 0 {
			continue
		}
		if mp, ok := listed(points, r.MountPoint); ok && !portAnswers(ctx, r.NFSPort) {
			broken = append(broken, mp)
		}
	}
	return broken
}

func portAnswers(ctx context.Context, port int) bool {
	d := net.Dialer{Timeout: time.Second}
	c, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}
