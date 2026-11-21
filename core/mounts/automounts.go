package mounts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rclone/rclone/fs/cache"
	fsops "github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// probeWait limits how long one check of a source can take, either the form's check or one
// attempt at start.
const probeWait = 10 * time.Second

// ErrNoAutomount is returned for an id that no automount is saved under.
var ErrNoAutomount = errs.NotFound("automount", "This automount was deleted.")

// Automounts returns every automount, by remote, then folder, then mount point, with whether it
// is mounted now and whether its remote is in the config.
func (s *Service) Automounts(ctx context.Context) ([]AutomountRow, error) {
	all, err := readStored(ctx, s.o.DB)
	if err != nil {
		return nil, err
	}
	names := s.o.RemoteNames()
	running := s.reg.All()
	out := make([]AutomountRow, len(all))
	for i, a := range all {
		out[i] = AutomountRow{Automount: a, RemoteMissing: !slices.Contains(names, a.Remote)}
		m, err := s.o.command(a.args(), s.env(1))
		if err != nil {
			continue
		}
		for _, c := range running {
			if samePath(c.Own.folder, m.CacheDir, s.o.goos) {
				out[i].MountID = c.ID
				break
			}
		}
	}
	return out, nil
}

// SaveAutomount checks an automount and saves it, creating it when it has no id. The checks are:
//   - The remote must be in the config, and the mount point must be set. An empty remote path
//     means the remote's root.
//   - No other automount that is on may use the same mount point.
//   - Its command line must build, which checks the options, such as a metadata mapper without
//     `metadata`.
//   - When it is on, its source is probed. A missing path or a file is refused, but a probe that
//     can't tell either way is not.
//
// A refusal is a user error, or an errs.Field when it concerns one field.
func (s *Service) SaveAutomount(ctx context.Context, a Automount) (Automount, error) {
	a.Remote = strings.TrimSpace(a.Remote)
	a.MountPoint = strings.TrimSpace(a.MountPoint)
	if a.Remote == "" {
		return Automount{}, errs.Field("remote", "Please choose a remote")
	}
	if !slices.Contains(s.o.RemoteNames(), a.Remote) {
		return Automount{}, errs.Field("remote", "There is no remote named %s.", a.Remote)
	}
	if a.MountPoint == "" {
		return Automount{}, errs.Field("mountPoint", "Please choose a mount point")
	}
	if err := operations.StoreMapper(&a.Options); err != nil {
		return Automount{}, err
	}
	all, err := readStored(ctx, s.o.DB)
	if err != nil {
		return Automount{}, err
	}
	if a.Enabled && a.MountPoint != "*" {
		for _, o := range all {
			if o.ID != a.ID && o.Enabled && samePath(o.MountPoint, a.MountPoint, s.o.goos) {
				// i18n: The value is the other automount's source, as in "gdrive:Photos".
				return Automount{}, errs.Field("mountPoint", "The automount of %s:%s already uses this mount point.", o.Remote, o.RemotePath)
			}
		}
	}
	if _, err := s.o.command(a.args(), s.env(1)); err != nil {
		return Automount{}, err
	}
	if a.Enabled {
		if err := s.probeForm(ctx, a.Remote, a.RemotePath); err != nil {
			return Automount{}, err
		}
	}
	raw, err := json.Marshal(a.Options)
	if err != nil {
		return Automount{}, err
	}
	creating := a.ID == ""
	if creating {
		a.ID, a.CreatedAt = uuid.NewString(), s.o.Now().UnixMilli()
	}
	err = s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		if creating {
			_, err := tx.ExecContext(ctx, `INSERT INTO automounts (id, remote, remote_path, mount_point, options, enabled, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`, a.ID, a.Remote, a.RemotePath, a.MountPoint, string(raw), a.Enabled, a.CreatedAt)
			return err
		}
		return tx.QueryRowContext(ctx, `UPDATE automounts SET remote = ?, remote_path = ?, mount_point = ?, options = ?,
			enabled = ? WHERE id = ? RETURNING created_at`, a.Remote, a.RemotePath, a.MountPoint, string(raw), a.Enabled,
			a.ID).Scan(&a.CreatedAt)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Automount{}, ErrNoAutomount
	}
	if err != nil {
		return Automount{}, err
	}
	s.automountsChanged()
	return a, nil
}

// DeleteAutomount deletes an automount. A mount that it started keeps running.
func (s *Service) DeleteAutomount(ctx context.Context, id string) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM automounts WHERE id = ?`, id)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNoAutomount
	}
	s.automountsChanged()
	return nil
}

// MountAutomount mounts an automount now, as the app does at start, but without probing its
// source first: a failure is returned to the page instead.
func (s *Service) MountAutomount(ctx context.Context, id string) (Mount, error) {
	all, err := readStored(ctx, s.o.DB)
	if err != nil {
		return Mount{}, err
	}
	i := slices.IndexFunc(all, func(a Automount) bool { return a.ID == id })
	if i < 0 {
		return Mount{}, ErrNoAutomount
	}
	return s.start(ctx, all[i].args(), startOpts{automount: true})
}

// RenameRemote rewrites the automounts of the remote from, after it is renamed to to. It makes
// the service one of the remotes' followers (remotes.Follower).
func (s *Service) RenameRemote(ctx context.Context, from, to string) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE automounts SET remote = ? WHERE remote = ?`, to, from)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err == nil && n > 0 {
		s.automountsChanged()
	}
	return err
}

func (s *Service) automountsChanged() { s.o.Bus.Publish(bus.AutomountsChanged, nil) }

// probeForm checks the form's source. It refuses only a source that doesn't exist or is a file,
// because a remote that doesn't respond now may respond at start.
func (s *Service) probeForm(ctx context.Context, remote, remotePath string) error {
	problem, err := s.probeSource(ctx, remote, remotePath)
	if err != nil {
		s.log.WarnContext(ctx, "the automount's source probe was inconclusive", "remote", remote, "error", err)
		return nil
	}
	return problem
}

// listSource lists the mount's folder, up to the end of the first page.
func (s *Service) listSource(ctx context.Context, remote, remotePath string) error {
	root, filePath := sourceRoot(remote, remotePath)
	ctx, cancel := context.WithTimeout(ctx, probeWait)
	defer cancel()
	return s.o.list(ctx, root, filePath)
}

// probeSource checks a mount's source. It lists a root, and stats a path under it. problem is a
// field error on remotePath that says the source is wrong (missing, or a file), which no retry
// can fix. err means the source didn't respond. A stat doesn't follow a symlink, so what it calls
// a file is also listed as a root, as the mount opens it: a link to a folder (such as /tmp on
// macOS) is a folder.
func (s *Service) probeSource(ctx context.Context, remote, remotePath string) (problem, err error) {
	root, filePath := sourceRoot(remote, remotePath)
	ctx, cancel := context.WithTimeout(ctx, probeWait)
	defer cancel()
	if filePath == "" {
		return nil, s.o.list(ctx, root, "")
	}
	found, isDir, err := s.o.stat(ctx, root, filePath)
	switch {
	case err != nil:
		return nil, err
	case !found:
		// i18n: The values are a folder and the remote it was looked for on, as in "gdrive:".
		return errs.Field("remotePath", `"%s" was not found on %s.`, filePath, root), nil
	case !isDir && s.o.list(ctx, root+filePath, "") != nil:
		return errs.Field("remotePath", `"%s" on %s is a file, not a folder.`, filePath, root), nil
	}
	return nil, nil
}

// sourceRoot returns the Fs in which a mount's remote path is checked, and the path within it.
// A leading slash belongs to the root (`remote:/` is the machine's root on sftp).
func sourceRoot(remote, remotePath string) (root, filePath string) {
	root, filePath = remote+":", strings.Trim(remotePath, "/")
	if strings.HasPrefix(remotePath, "/") {
		root += "/"
	}
	return root, filePath
}

// listFirstPage lists dir in the Fs root through rclone, up to the end of the first page
// (rclone.FirstPage). A source that returns that much exists.
func listFirstPage(ctx context.Context, root, dir string) error {
	_, err := rclone.Run(ctx, rclone.CallOpts{}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, root)
		if err != nil {
			return err
		}
		return rclone.FirstPage(ctx, f, dir)
	})
	return err
}

// statEntry stats remote in the Fs root through rclone, without reading its modtime or type. It
// uses operations.StatJSON, as the browser's Stat does.
func statEntry(ctx context.Context, root, remote string) (found, isDir bool, err error) {
	_, err = rclone.Run(ctx, rclone.CallOpts{}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, root)
		if err != nil {
			return err
		}
		item, err := fsops.StatJSON(ctx, f, remote, &fsops.ListJSONOpt{NoModTime: true, NoMimeType: true})
		if err != nil {
			return err
		}
		found, isDir = item != nil, item != nil && item.IsDir
		return nil
	})
	return found, isDir, err
}

// readStored reads the automounts, by remote, then folder, then mount point.
func readStored(ctx context.Context, d *db.DB) ([]Automount, error) {
	var out []Automount
	err := d.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id, remote, remote_path, mount_point, options, enabled, created_at
			FROM automounts ORDER BY remote, remote_path, mount_point, id`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, func(r db.Scanner) (Automount, error) {
			var a Automount
			var raw string
			if err := r.Scan(&a.ID, &a.Remote, &a.RemotePath, &a.MountPoint, &raw, &a.Enabled, &a.CreatedAt); err != nil {
				return Automount{}, err
			}
			if err := json.Unmarshal([]byte(raw), &a.Options); err != nil {
				return Automount{}, fmt.Errorf("the automount of %s: %w", a.Remote, err)
			}
			return a, nil
		})
		return err
	})
	return out, err
}

// enabled returns the automounts that would run: switched on and with a mount point.
func enabled(all []Automount) []Automount {
	var out []Automount
	for _, a := range all {
		if a.Enabled && a.MountPoint != "" {
			out = append(out, a)
		}
	}
	return out
}

// AutomountPoints returns the mount points of the enabled automounts. The cleanup of leftovers
// uses them (children.LeftoverOptions.Automounts), and they are read before the services start.
func AutomountPoints(ctx context.Context, d *db.DB, goos string) ([]string, error) {
	all, err := readStored(ctx, d)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, a := range enabled(all) {
		m, err := operations.MountCommand(a.args(), operations.MountEnv{OS: goos, NFSPort: 1})
		if err == nil && m.MountPoint != "*" {
			out = append(out, m.MountPoint)
		}
	}
	slices.Sort(out)
	return slices.Compact(out), nil
}

// automountFolders returns the cache folders of the enabled automounts, which are kept. ok is
// false when the automounts can't be read, so that nothing is deleted when in doubt.
func (s *Service) automountFolders(ctx context.Context) (folders map[string]bool, ok bool) {
	all, err := readStored(ctx, s.o.DB)
	if err != nil {
		s.log.WarnContext(ctx, "could not read the automounts", "error", err)
		return nil, false
	}
	folders = map[string]bool{}
	for _, a := range enabled(all) {
		if m, err := s.o.command(a.args(), s.env(1)); err == nil {
			folders[filepath.Clean(m.CacheDir)] = true
		}
	}
	return folders, true
}

// automountFolder reports whether folder belongs to an enabled automount, or whether that
// can't be determined.
func (s *Service) automountFolder(ctx context.Context, folder string) bool {
	folders, ok := s.automountFolders(ctx)
	return !ok || folders[filepath.Clean(folder)]
}
