package templates

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/operations"
)

// A rename rewrites the templates that name the remote, and publishes the change.
func TestRenameRemote(t *testing.T) {
	ctx := context.Background()
	b := bus.New()
	s := New(testdb.Open(t), b, "")
	for _, tmpl := range []*Template{
		{ID: "a", Name: "Backup", Options: opts(`{"backup_dir": "old:Trash", "transfers": 4}`)},
		{ID: "b", Name: "Plain", Options: opts(`{"transfers": 8}`)},
	} {
		if _, err := s.Save(ctx, tmpl); err != nil {
			t.Fatal(err)
		}
	}
	sub := b.Subscribe()
	defer sub.Close()
	if err := s.RenameRemote(ctx, "old", "new"); err != nil {
		t.Fatal(err)
	}
	all, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if text(all[0].Options) != `{"backup_dir":"new:Trash","transfers":4}` || text(all[1].Options) != `{"transfers":8}` {
		t.Errorf("after the rename: %s %s", text(all[0].Options), text(all[1].Options))
	}
	select {
	case ev := <-sub.C:
		if ev.Name != bus.TemplatesChanged {
			t.Errorf("published %s", ev.Name)
		}
	default:
		t.Error("the change wasn't published")
	}
	// Nothing names the remote now, so a second rename changes nothing and publishes nothing.
	if err := s.RenameRemote(ctx, "old", "new"); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-sub.C:
		t.Errorf("published %s", ev.Name)
	default:
	}
}

// A rename rewrites the template's paths too, and leaves other remotes and local paths alone.
func TestRenameRemoteInPaths(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New(), "")
	for _, tmpl := range []*Template{
		{ID: "a", Name: "Both", Tags: []operations.Operation{"copy"}, Options: opts(`{"transfers": 4}`),
			Paths: &Paths{Sources: []string{"old:a", "older:b", "/old:c", "old,link=x:d"}, Destination: "old:"}},
		{ID: "b", Name: "Dest", Paths: &Paths{Destination: "other:x"}},
	} {
		if _, err := s.Save(ctx, tmpl); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RenameRemote(ctx, "old", "new"); err != nil {
		t.Fatal(err)
	}
	a, err := s.Get(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"new:a", "older:b", "/old:c", "new,link=x:d"}; !slices.Equal(a.Paths.Sources, want) || a.Paths.Destination != "new:" {
		t.Errorf("paths after the rename: %+v", a.Paths)
	}
	if text(a.Options) != `{"transfers":4}` {
		t.Errorf("options changed: %s", text(a.Options))
	}
	if b, err := s.Get(ctx, "b"); err != nil || b.Paths.Destination != "other:x" {
		t.Errorf("another remote's template: %+v %v", b, err)
	}
}

// opts returns a template's options from their JSON.
func opts(raw string) catalog.Group {
	var g catalog.Group
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		panic(err)
	}
	return g
}

// text returns a template's options as they are stored.
func text(g catalog.Group) string {
	s, err := marshal(g)
	if err != nil {
		panic(err)
	}
	return s
}
