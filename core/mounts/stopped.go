package mounts

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
)

// ErrNoStopped is returned for a folder that doesn't belong to any stopped mount.
var ErrNoStopped = errs.NotFound("stopped mount", "These uploads are no longer pending.")

// maxMetaFile limits how much of one vfsMeta file is read. Each file is a few hundred bytes.
const maxMetaFile = 1 << 20

// settle decides what happens to a mount's cache folder once its child has exited. When uploads
// are waiting there, the folder is kept and listed in stopped_mounts (keepWaiting). Otherwise it
// is deleted, unless it belongs to an automount. A folder that couldn't be read is kept.
func (s *Service) settle(ctx context.Context, c *child, queued int) {
	n, known := s.keepWaiting(ctx, c.Log, waitingOf(c), queued)
	folder := c.Own.folder
	if !known || n > 0 || c.Own.automount || s.automountFolder(ctx, folder) || !cacheFolder(folder) {
		return
	}
	if err := os.RemoveAll(folder); err != nil {
		c.Log.WarnContext(ctx, "could not delete the mount's cache", "folder", folder, "error", err)
	}
}

// waiting is a stopped mount whose cache folder may hold uploads that rclone hadn't sent, as
// stored in stopped_mounts.
type waiting struct {
	folder     string // the cache folder, <CacheRoot>/vfs/<16 hex>
	args       operations.MountArgs
	mountPoint string
}

func waitingOf(c *child) waiting {
	return waiting{folder: c.Own.folder, args: c.Own.args, mountPoint: c.Own.mountPoint}
}

// keepWaiting counts the uploads waiting in w's cache folder, and records w in stopped_mounts
// when there are any, so that the folder is kept. The count is the larger of two numbers. The
// first is queued, which is vfs/queue as read before the stop, or < 0 when it couldn't be read.
// The second is the number of items that rclone marks dirty in the folder. That number also
// includes a file that was still open for writing at the stop, which stays out of the queue
// until it is closed, and a file closed after the queue was read. known reports whether n can
// be trusted, which is when the folder could be read or the queue had uploads.
func (s *Service) keepWaiting(ctx context.Context, log *slog.Logger, w waiting, queued int) (n int, known bool) {
	dirty, err := dirtyItems(w.folder)
	known = err == nil || queued > 0
	if err != nil {
		log.WarnContext(ctx, "could not look into the mount's cache", "folder", w.folder, "error", err)
	}
	if n = max(dirty, queued, 0); n == 0 {
		return 0, known
	}
	if err := s.recordStopped(ctx, filepath.Base(w.folder), w.args, w.mountPoint, n); err != nil {
		log.ErrorContext(ctx, "could not record the uploads the mount still had waiting; its cache is kept", "folder", w.folder, "error", err)
		return n, known
	}
	log.InfoContext(ctx, "the mount stopped with uploads waiting; its cache is kept", "pending", n, "folder", w.folder)
	return n, known
}

// dirtyItems counts the files in a VFS cache folder that rclone hasn't uploaded yet. These are
// the vfsMeta entries with "Dirty": true (vfs/vfscache/item.go Info). An entry that doesn't
// decode, for example because rclone was killed while writing it, is counted too, so that
// nothing is deleted when in doubt. A missing folder counts as zero.
func dirtyItems(folder string) (int, error) {
	n := 0
	err := filepath.WalkDir(filepath.Join(folder, "vfsMeta"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		var info struct{ Dirty bool }
		err = json.NewDecoder(io.LimitReader(f, maxMetaFile)).Decode(&info)
		_ = f.Close()
		if err != nil || info.Dirty {
			n++
		}
		return nil
	})
	return n, err
}

// recordStopped stores a stopped mount that has uploads waiting, and sends mounts.changed. A
// later stop with the same folder replaces the row.
func (s *Service) recordStopped(ctx context.Context, folder string, a operations.MountArgs, mountPoint string, pending int) error {
	args, err := json.Marshal(a)
	if err != nil {
		return err
	}
	err = s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO stopped_mounts (folder, source, mount_point, args, pending, stopped_ms)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (folder) DO UPDATE SET source = excluded.source, mount_point = excluded.mount_point,
				args = excluded.args, pending = excluded.pending, stopped_ms = excluded.stopped_ms`,
			folder, a.Source, mountPoint, string(args), pending, s.o.Now().UnixMilli())
		return err
	})
	if err == nil {
		s.changed(bus.MountsChangedData{State: string(children.StatusStopped)})
	}
	return err
}

// deleteStopped removes a stopped mount that was mounted again or discarded, and sends
// mounts.changed.
func (s *Service) deleteStopped(ctx context.Context, folder string) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, `DELETE FROM stopped_mounts WHERE folder = ?`, folder)
		if err == nil {
			n, err = r.RowsAffected()
		}
		return err
	})
	if err == nil && n > 0 {
		s.changed(bus.MountsChangedData{State: string(children.StatusStopped)})
	}
	return err
}

// Stopped returns the stopped mounts that have uploads waiting, newest first, for the Mount
// page's list.
func (s *Service) Stopped(ctx context.Context) ([]StoppedMount, error) {
	out := []StoppedMount{}
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT folder, source, mount_point, args, pending
			FROM stopped_mounts ORDER BY stopped_ms DESC, folder`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, func(r db.Scanner) (StoppedMount, error) {
			var (
				m       StoppedMount
				args    string
				pending sql.NullInt64
			)
			if err := r.Scan(&m.Folder, &m.Source, &m.MountPoint, &args, &pending); err != nil {
				return m, err
			}
			if err := json.Unmarshal([]byte(args), &m.Args); err != nil {
				return m, fmt.Errorf("stopped mount %s: %w", m.Folder, err)
			}
			if pending.Valid {
				m.Pending = &pending.Int64
			}
			return m, nil
		})
		return err
	})
	return out, err
}

func (s *Service) stopped(ctx context.Context, folder string) (StoppedMount, error) {
	list, err := s.Stopped(ctx)
	if err != nil {
		return StoppedMount{}, err
	}
	for _, m := range list {
		if m.Folder == folder {
			return m, nil
		}
	}
	return StoppedMount{}, ErrNoStopped
}

// MountAgain starts a stopped mount again with its recorded arguments. It uses the same cache
// folder, so rclone sends the uploads that are waiting there. The row is removed once the mount
// runs.
func (s *Service) MountAgain(ctx context.Context, folder string) (Mount, error) {
	if !validFolder(folder) {
		return Mount{}, ErrNoStopped
	}
	m, err := s.stopped(ctx, folder)
	if err != nil {
		return Mount{}, err
	}
	return s.start(ctx, m.Args, startOpts{})
}

// Discard deletes a stopped mount's cache folder, including the uploads that were waiting
// there, and removes its row.
func (s *Service) Discard(ctx context.Context, folder string) error {
	if !validFolder(folder) {
		return ErrNoStopped
	}
	if _, err := s.stopped(ctx, folder); err != nil {
		return err
	}
	for _, c := range s.reg.All() {
		if filepath.Base(c.Own.folder) == folder {
			return errs.New("A mount of this source at this place is running and sending these uploads.")
		}
	}
	if path := filepath.Join(s.o.CacheRoot, "vfs", folder); !cacheFolder(path) {
		return fmt.Errorf("no cache folder %s", path)
	} else if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("delete the waiting uploads: %w", err)
	}
	return s.deleteStopped(ctx, folder)
}

// cacheFolder reports whether path is a mount's cache folder, <CacheRoot>/vfs/<16 hex>. Only
// such a folder is ever deleted.
func cacheFolder(path string) bool {
	return filepath.IsAbs(path) && validFolder(filepath.Base(path)) && filepath.Base(filepath.Dir(path)) == "vfs"
}

// validFolder reports whether folder is a valid cache folder name: 16 hex characters, never a
// path.
func validFolder(folder string) bool {
	if len(folder) != 16 {
		return false
	}
	_, err := hex.DecodeString(folder)
	return err == nil
}
