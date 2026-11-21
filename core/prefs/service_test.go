package prefs

import (
	"context"
	"maps"
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testdb"
)

func TestSetGetDelete(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	for k, v := range map[string]string{"appearance.app": `"dark"`, "acknowledgements": `["openShortcut"]`, "theme": `"light"`} {
		if err := s.Set(ctx, k, v); err != nil {
			t.Fatal(err)
		}
	}
	all, err := s.Get(ctx, nil)
	if err != nil || len(all) != 3 {
		t.Fatalf("all: %v %v", all, err)
	}
	some, _ := s.Get(ctx, []string{"theme", "missing"})
	if !maps.Equal(some, map[string]string{"theme": `"light"`}) {
		t.Errorf("some: %v", some)
	}
	if err := s.Set(ctx, "theme", `"system"`); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Get(ctx, []string{"theme"}); v["theme"] != `"system"` {
		t.Errorf("overwrite: %v", v)
	}
	if err := s.Set(ctx, "theme", ""); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Get(ctx, []string{"theme"}); len(v) != 0 {
		t.Errorf("deleted: %v", v)
	}
}

func TestRefusals(t *testing.T) {
	s := New(testdb.Open(t), bus.New())
	for _, c := range [][3]string{{"", `1`, "key"}, {"a b", `1`, "key"}, {"k", `{not json`, "value"}} {
		if err := s.Set(context.Background(), c[0], c[1]); errs.FieldOf(err) != c[2] {
			t.Errorf("Set(%q, %q) = %v, want a refusal of %s", c[0], c[1], err, c[2])
		}
	}
}
