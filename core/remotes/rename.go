package remotes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

func (s *Service) rename(ctx context.Context, old, new string) (*StepResult, error) {
	if !s.exists(old) {
		return nil, ErrNotFound
	}
	if new == old {
		return nil, errs.Field("name", "That is the remote's name already.")
	}
	if err := rclone.CheckNewRemoteName("name", new, s.st.GetSectionList()); err != nil {
		return nil, err
	}

	s.hold()
	err := s.renameSection(old, new)
	if err == nil {
		err = s.carry(ctx, old, new)
		if err != nil {
			if back := s.renameSection(new, old); back != nil {
				s.log.ErrorContext(ctx, "remotes: undoing a rename", "old", old, "new", new, "error", back)
			}
		}
	}
	s.release(old, new)
	if err != nil {
		return nil, err
	}

	res := &StepResult{Name: new}
	for _, f := range s.followers {
		var nr *location.NotRewrittenError
		switch err := f.RenameRemote(ctx, old, new); {
		case err == nil:
		case errors.As(err, &nr):
			res.NotRewritten = append(res.NotRewritten, nr.Items...)
		default:
			res.NotRewritten = append(res.NotRewritten, err)
		}
	}
	return res, nil
}

func (s *Service) renameSection(old, new string) error {
	if s.st.HasSection(new) {
		return errs.Field("name", "A remote called %s already exists.", new)
	}
	keys := s.st.GetKeyList(old)
	if keys == nil {
		return ErrNotFound
	}
	values := make([]string, len(keys))
	for i, k := range keys {
		values[i], _ = s.st.GetValue(old, k)
		s.st.SetValue(new, k, values[i])
	}
	s.st.DeleteSection(old)
	if err := s.saveError(); err != nil {
		s.st.DeleteSection(new)
		for i, k := range keys {
			s.st.SetValue(old, k, values[i])
		}
		return err
	}
	return nil
}

func (s *Service) carry(ctx context.Context, old, new string) error {
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM remote_fsinfo WHERE remote = ?`, new); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE remote_fsinfo SET remote = ? WHERE remote = ?`, new, old)
		return err
	})
	if err != nil {
		return fmt.Errorf("carry %s's data to %s: %w", old, new, err)
	}
	return nil
}
