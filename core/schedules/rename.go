package schedules

import (
	"context"
	"database/sql"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/operations"
)

// RenameRemote rewrites the schedules that name the remote from, after the remote is renamed to
// to (operations.Form.RenameRemote): their paths, the keys of their remotes options, the option
// values that name a path on it, and a bisync's backup folders. It makes the service one of the
// remotes' followers (remotes.Follower). bisync names its listings after the paths, so a bisync
// whose paths changed is no longer baselined: its next run merges the folders, which deletes
// nothing.
func (s *Service) RenameRemote(ctx context.Context, from, to string) error {
	moved := false
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		moved = false
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM schedules`)
		if err != nil {
			return err
		}
		all, err := db.Collect(rows, scan)
		if err != nil {
			return err
		}
		for _, sc := range all {
			changed, paths := sc.Form.RenameRemote(from, to)
			if !changed {
				continue
			}
			args, err := sc.Form.MarshalArgs()
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE schedules SET args = ?,
				baselined = CASE WHEN ? THEN 0 ELSE baselined END WHERE id = ?`,
				string(args), paths && sc.Form.Operation == operations.OperationBisync, sc.ID); err != nil {
				return err
			}
			moved = true
		}
		return nil
	})
	if err != nil {
		return err
	}
	if moved {
		s.changed()
	}
	return nil
}
