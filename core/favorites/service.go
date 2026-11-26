package favorites

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

var ErrNoPath = errs.Field("path", "a favourite needs a path")

type Service struct {
	db  *db.DB
	bus *bus.Bus
}

func New(d *db.DB, b *bus.Bus) *Service { return &Service{db: d, bus: b} }

func (s *Service) List(ctx context.Context) ([]Favorite, error) {
	out := []Favorite{}
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT path, added_at FROM favorites ORDER BY added_at, path`)
		if err != nil {
			return err
		}
		got, err := db.Collect(rows, func(r db.Scanner) (Favorite, error) {
			var f Favorite
			err := r.Scan(&f.Path, &f.AddedAt)
			return f, err
		})
		if got != nil {
			out = got
		}
		return err
	})
	return out, err
}

func (s *Service) Add(ctx context.Context, path string) (Favorite, error) {
	if strings.TrimSpace(path) == "" {
		return Favorite{}, ErrNoPath
	}
	added := time.Now().UnixMilli()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO favorites (path, added_at) VALUES (?, ?) ON CONFLICT (path) DO NOTHING`, path, added); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT added_at FROM favorites WHERE path = ?`, path).Scan(&added)
	})
	if err != nil {
		return Favorite{}, err
	}
	s.bus.Publish(bus.FavoritesChanged, nil)
	return Favorite{Path: path, AddedAt: added}, nil
}

func (s *Service) Remove(ctx context.Context, path string) error {
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM favorites WHERE path = ?`, path)
		return err
	})
	if err == nil {
		s.bus.Publish(bus.FavoritesChanged, nil)
	}
	return err
}

func (s *Service) RenameRemote(ctx context.Context, from, to string) error {
	var left []error
	changed := false
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		left, changed = nil, false
		rows, err := tx.QueryContext(ctx, `SELECT path FROM favorites ORDER BY path`)
		if err != nil {
			return err
		}
		paths, err := db.Collect(rows, func(r db.Scanner) (string, error) {
			var path string
			err := r.Scan(&path)
			return path, err
		})
		if err != nil {
			return err
		}
		for _, path := range paths {
			renamed, ok := location.RenameRemote(path, from, to)
			if !ok {
				continue
			}
			res, err := tx.ExecContext(ctx, `UPDATE OR IGNORE favorites SET path = ? WHERE path = ?`, renamed, path)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				left = append(left, errs.Errorf("Couldn’t update the favorite %s: %s is already a favorite.", path, renamed))
				continue
			}
			changed = true
		}
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		s.bus.Publish(bus.FavoritesChanged, nil)
	}
	if len(left) > 0 {
		return &location.NotRewrittenError{Items: left}
	}
	return nil
}
