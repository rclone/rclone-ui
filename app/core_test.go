package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/db"
)

// TestSchemaChangeOffersTheDataFolder uses the error that db.Open returns for a file without the
// schema's hash, wrapped as the core's boot wraps it.
func TestSchemaChangeOffersTheDataFolder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	d, err := db.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.W.Exec(`DELETE FROM meta WHERE key = 'schema'`); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = db.Open(context.Background(), path)
	if err == nil {
		t.Fatal("a file without the schema's hash was opened")
	}
	if got := failedChoice(fmt.Errorf("database: %w", err)); got != showDataFolder {
		t.Fatalf("a changed schema offers %q", got)
	}
	if got := failedChoice(fmt.Errorf("database: %w", db.ErrNotWAL)); got != tryAgain {
		t.Fatalf("another failure offers %q", got)
	}
	if got := failedChoice(errors.New("run directory: denied")); got != tryAgain {
		t.Fatalf("another failure offers %q", got)
	}
}
