package templates

import (
	"context"
	"database/sql"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/location"
)

// RenameRemote rewrites the templates that name the remote from, after the remote is renamed to
// to. It makes the service one of the remotes' followers (remotes.Follower). Each template is
// rewritten by renameRemote, which is the place to add more of a template's fields that hold
// paths.
func (s *Service) RenameRemote(ctx context.Context, from, to string) error {
	changed := false
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		changed = false
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM templates`)
		if err != nil {
			return err
		}
		ts, err := db.Collect(rows, scan)
		if err != nil {
			return err
		}
		for _, t := range ts {
			if !t.renameRemote(from, to) {
				continue
			}
			if err := put(ctx, tx, t); err != nil {
				return err
			}
			changed = true
		}
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		s.bus.Publish(bus.TemplatesChanged, nil)
	}
	return nil
}

// renameRemote rewrites the paths on the remote from to name the remote to, in the options and
// in the template's paths. It reports whether anything changed.
func (t *Template) renameRemote(from, to string) bool {
	moved := t.Options.RenameRemote(from, to)
	if t.Paths != nil {
		for i, src := range t.Paths.Sources {
			if p, ok := location.RenameRemote(src, from, to); ok {
				t.Paths.Sources[i] = p
				moved = true
			}
		}
		if p, ok := location.RenameRemote(t.Paths.Destination, from, to); ok {
			t.Paths.Destination = p
			moved = true
		}
	}
	return moved
}
