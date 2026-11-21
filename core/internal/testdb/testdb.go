// Package testdb opens a new app.db at this build's schema for a test.
package testdb

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/db"
)

// Open returns a new database in t's temp dir. It is closed when the test ends.
func Open(t testing.TB) *db.DB {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}
