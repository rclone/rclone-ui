package watchers

import (
	"context"
	"database/sql"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/location"
)

// RenameRemote rewrites the folders of the watchers on the remote from, after the remote is
// renamed to to. It makes the service one of the remotes' followers (remotes.Follower). bisync
// names its listings after the remote, so a rewritten watcher is no longer baselined: its next run
// merges the folders again, which deletes nothing. It runs at once, as after an edit of its
// folders.
func (s *Service) RenameRemote(ctx context.Context, from, to string) error {
	var moved []string
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		moved = nil
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM watchers`)
		if err != nil {
			return err
		}
		ws, err := db.Collect(rows, scan)
		if err != nil {
			return err
		}
		for _, w := range ws {
			a, okA := location.RenameRemote(w.PathA, from, to)
			b, okB := location.RenameRemote(w.PathB, from, to)
			if !okA && !okB {
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE watchers SET path_a = ?, path_b = ?, baselined = 0,
				attention = '', deleted_side = '' WHERE id = ?`, a, b, w.ID); err != nil {
				return err
			}
			moved = append(moved, w.ID)
		}
		return nil
	})
	if err != nil || len(moved) == 0 {
		return err
	}
	s.changed()
	for _, id := range moved {
		s.kick(id, modeNormal)
	}
	return nil
}
