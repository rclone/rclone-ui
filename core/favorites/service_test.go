package favorites

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/location"
)

func paths(t *testing.T, s *Service) []string {
	t.Helper()
	fs, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range fs {
		out = append(out, f.Path)
	}
	return out
}

func TestFavorites(t *testing.T) {
	ctx := context.Background()
	d := testdb.Open(t)
	s := New(d, bus.New())
	// A favorite added an hour ago, which Add can't make.
	old := time.Now().Add(-time.Hour)
	if err := d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO favorites (path, added_at) VALUES (?, ?)`, "gdrive:Photos", old.UnixMilli())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(ctx, ""); !errors.Is(err, ErrNoPath) {
		t.Errorf("an empty path: %v", err)
	}
	if _, err := s.Add(ctx, "/Users/me/Documents"); err != nil {
		t.Fatal(err)
	}
	// Adding again keeps the first time.
	f, err := s.Add(ctx, "gdrive:Photos")
	if err != nil || f.AddedAt != old.UnixMilli() {
		t.Errorf("re-add: %v %v", f, err)
	}
	if got := paths(t, s); len(got) != 2 || got[0] != "gdrive:Photos" {
		t.Errorf("list %v", got)
	}
	if err := s.RenameRemote(ctx, "gdrive", "drive"); err != nil {
		t.Fatal(err)
	}
	if got := paths(t, s); got[0] != "drive:Photos" {
		t.Errorf("after the rename %v", got)
	}
	if err := s.Remove(ctx, "drive:Photos"); err != nil {
		t.Fatal(err)
	}
	if got := paths(t, s); len(got) != 1 || got[0] != "/Users/me/Documents" {
		t.Errorf("after Remove %v", got)
	}
}

// TestRenameOntoAFavourite checks that a favorite whose new path is already a favorite stays under
// the old name, and that the rename reports it. The other favorites move to the new name.
func TestRenameOntoAFavourite(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	for _, p := range []string{"old:Photos", "old:Docs", "new:Photos"} {
		if _, err := s.Add(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	err := s.RenameRemote(ctx, "old", "new")
	var nr *location.NotRewrittenError
	if !errors.As(err, &nr) || len(nr.Items) != 1 || !strings.Contains(nr.Items[0].Error(), "old:Photos") || !strings.Contains(nr.Items[0].Error(), "new:Photos") {
		t.Fatalf("the rename answered %v", err)
	}
	if got, want := paths(t, s), []string{"new:Docs", "new:Photos", "old:Photos"}; !slices.Equal(slices.Sorted(slices.Values(got)), want) {
		t.Errorf("after the rename %v, want %v", got, want)
	}
}

// TestRenameNonASCII checks that renaming a remote whose name isn't ASCII updates its favorites,
// and only its own.
func TestRenameNonASCII(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	for _, p := range []string{"Fotos:2024", "Fötos:2024", "Fötos:"} {
		if _, err := s.Add(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RenameRemote(ctx, "Fotos", "Pics"); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameRemote(ctx, "Fötos", "Bilder"); err != nil {
		t.Fatal(err)
	}
	if got, want := paths(t, s), []string{"Bilder:", "Bilder:2024", "Pics:2024"}; !slices.Equal(slices.Sorted(slices.Values(got)), want) {
		t.Errorf("after the renames %v, want %v", got, want)
	}
}

// TestRenameConnectionString checks that a favorite on the remote written as a connection string
// follows the rename with its parameters, as rclone reads it. A favorite on another remote whose
// name starts the same, or on a ":from:" backend, is left alone. A rename that changes nothing
// publishes nothing.
func TestRenameConnectionString(t *testing.T) {
	ctx := context.Background()
	b := bus.New()
	s := New(testdb.Open(t), b)
	for _, p := range []string{"gdrive,opt=x:dir", "gdrive:a", "gdriveold:b", ":gdrive:c", "/Users/me/gdrive:d"} {
		if _, err := s.Add(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	sub := b.Subscribe()
	defer sub.Close()
	if err := s.RenameRemote(ctx, "gdrive", "drive"); err != nil {
		t.Fatal(err)
	}
	want := []string{"/Users/me/gdrive:d", ":gdrive:c", "drive,opt=x:dir", "drive:a", "gdriveold:b"}
	if got := paths(t, s); !slices.Equal(slices.Sorted(slices.Values(got)), want) {
		t.Errorf("after the rename %v, want %v", got, want)
	}
	if len(sub.C) != 1 {
		t.Errorf("the rename published %d events, want 1", len(sub.C))
	}
	<-sub.C
	if err := s.RenameRemote(ctx, "nothing", "else"); err != nil {
		t.Fatal(err)
	}
	if len(sub.C) != 0 {
		t.Error("a rename that changed nothing published favorites.changed")
	}
}
