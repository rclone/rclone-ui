package launcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
)

const (
	keepFor    = 90 * 24 * time.Hour
	maxKeys    = 2000
	maxQueries = 5
)

var ErrNoKey = errs.Field("key", "a launcher result needs a key")

type Service struct {
	db  *db.DB
	now func() time.Time
}

func New(d *db.DB) *Service { return &Service{db: d, now: time.Now} }

func (s *Service) Prune(ctx context.Context) error {
	cutoff := s.now().Add(-keepFor).UnixMilli()
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM launcher_usage WHERE last_used < ?`, cutoff); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM launcher_usage WHERE key NOT IN (
			SELECT key FROM launcher_usage ORDER BY last_used DESC, key LIMIT ?)`, maxKeys)
		return err
	})
}

func (s *Service) Record(ctx context.Context, key, query string) error {
	if strings.TrimSpace(key) == "" {
		return ErrNoKey
	}
	query = strings.TrimSpace(query)
	now := s.now().UnixMilli()
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		var raw string
		err := tx.QueryRowContext(ctx, `SELECT queries FROM launcher_usage WHERE key = ?`, key).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		queries, err := json.Marshal(remember(decodeQueries(raw), query))
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO launcher_usage (key, count, last_used, queries) VALUES (?, 1, ?, ?)
			ON CONFLICT (key) DO UPDATE SET count = count + 1, last_used = excluded.last_used, queries = excluded.queries`,
			key, now, string(queries))
		return err
	})
}

func (s *Service) Usage(ctx context.Context) ([]*Usage, error) {
	var out []*Usage
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT key, count, last_used, queries FROM launcher_usage ORDER BY last_used DESC, key`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, func(r db.Scanner) (*Usage, error) {
			var u Usage
			var last int64
			var raw string
			err := r.Scan(&u.Key, &u.Count, &last, &raw)
			u.LastUsed, u.Queries = last, decodeQueries(raw)
			return &u, err
		})
		return err
	})
	return out, err
}

func (s *Service) Forget(ctx context.Context, key string) error {
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		if key == "" {
			_, err := tx.ExecContext(ctx, `DELETE FROM launcher_usage`)
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM launcher_usage WHERE key = ?`, key)
		return err
	})
}

func remember(queries []string, query string) []string {
	if query == "" {
		return queries
	}
	out := append([]string{query}, slices.DeleteFunc(queries, func(q string) bool { return q == query })...)
	return out[:min(len(out), maxQueries)]
}

func decodeQueries(raw string) []string {
	var qs []string
	if err := json.Unmarshal([]byte(raw), &qs); err != nil {
		return []string{}
	}
	if qs == nil {
		qs = []string{}
	}
	return qs
}
