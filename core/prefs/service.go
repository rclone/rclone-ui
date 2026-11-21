// Package prefs stores the pages' UI preferences, such as the app's theme, the notices the user
// acknowledged, and panel layouts. They are JSON values by key, which the core stores but never
// reads.
package prefs

import (
	"context"
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
)

// maxValue is the largest size of one value. Preferences are small.
const maxValue = 64 << 10

var keyRE = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)

type Service struct {
	db  *db.DB
	bus *bus.Bus
}

func New(d *db.DB, b *bus.Bus) *Service { return &Service{db: d, bus: b} }

// Get returns the values of keys, or of all keys when keys is empty. A key that was never set is
// left out.
func (s *Service) Get(ctx context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		query, args := `SELECT key, value FROM prefs`, []any{}
		if len(keys) > 0 {
			query += ` WHERE key IN (?` + strings.Repeat(`, ?`, len(keys)-1) + `)`
			for _, k := range keys {
				args = append(args, k)
			}
		}
		rows, err := tx.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var k, v string
			if err := rows.Scan(&k, &v); err != nil {
				return err
			}
			out[k] = v
		}
		return rows.Err()
	})
	return out, err
}

// Set writes key's JSON value. An empty value deletes the key.
func (s *Service) Set(ctx context.Context, key, value string) error {
	if !keyRE.MatchString(key) {
		return errs.Field("key", "A preference's key is 1 to 128 letters, digits and ._:-")
	}
	if len(value) > maxValue {
		return errs.Field("value", "A preference's value is at most 64 KiB.")
	}
	if value != "" && !json.Valid([]byte(value)) {
		return errs.Field("value", "A preference's value is JSON.")
	}
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		if value == "" {
			_, err := tx.ExecContext(ctx, `DELETE FROM prefs WHERE key = ?`, key)
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			key, value, db.NowMS())
		return err
	})
	if err != nil {
		return err
	}
	s.bus.Publish(bus.PrefsChanged, bus.PrefsChangedData{Names: []string{key}})
	return nil
}
