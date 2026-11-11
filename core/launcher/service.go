// Package launcher stores the launcher's usage history. For each result that the user picked in
// the launcher (identified by its Key), it records how often and when it was last picked, and for
// which queries. The launcher ranks higher the results that were picked often or recently, and
// those that were picked for the query being typed.
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
	// keepFor is how long a key that nobody picks is kept. After that, its history no longer
	// says anything about the user's current habits.
	keepFor = 90 * 24 * time.Hour
	// maxKeys limits the size of the table. Usage reads the whole table each time the launcher
	// refreshes, so a long-lived install with many folders mustn't make it grow forever.
	maxKeys = 2000
	// maxQueries is how many distinct queries are kept for each key. That is enough to recognize
	// the few ways that someone types to reach it.
	maxQueries = 5
)

var ErrNoKey = errs.Field("key", "a launcher result needs a key")

type Service struct {
	db  *db.DB
	now func() time.Time // replaced by a test's clock
}

func New(d *db.DB) *Service { return &Service{db: d, now: time.Now} }

// Prune deletes the keys last used more than 90 days ago, and then the oldest keys beyond the
// newest 2000. The core runs it once at start, because the history only grows by a little while
// the app runs.
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

// Record records that key was picked for query. It adds one use at the current time, and puts the
// trimmed query first among the key's last distinct queries. An empty query adds no query.
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

// Usage returns every key's history, the most recently used first.
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

// Forget deletes key's history. An empty key deletes the history of every key.
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

// remember moves query to the front of queries, removing any earlier copy of it and anything
// beyond maxQueries. An empty query leaves queries unchanged.
func remember(queries []string, query string) []string {
	if query == "" {
		return queries
	}
	out := append([]string{query}, slices.DeleteFunc(queries, func(q string) bool { return q == query })...)
	return out[:min(len(out), maxQueries)]
}

// decodeQueries reads a row's queries column. A value that isn't a JSON array of strings (as in
// a row edited by hand) is read as no queries. The count and the time are still worth keeping,
// and the next Record rewrites the whole column.
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
