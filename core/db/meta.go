package db

import (
	"context"
	"database/sql"
	"errors"
)

// GetMeta reads an app-level marker from the meta table (0001_base.sql). ok is false when the
// key isn't set.
func (d *DB) GetMeta(ctx context.Context, key string) (value string, ok bool, err error) {
	err = d.Read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

// SetMeta sets an app-level marker in tx, so it is saved together with the work it marks.
func SetMeta(ctx context.Context, tx *sql.Tx, key, value string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, NowMS())
	return err
}
