package vfs

import (
	"context"
	"errors"
	"testing"

	"github.com/rclone/rclone-ui/core/children"
)

// TestList checks that only the running children's VFSes are listed, with mounts before serves,
// and that forgetting one that is not running fails.
func TestList(t *testing.T) {
	rc := &children.RC{}
	s := New(
		func() []Target {
			return []Target{
				{ID: "s1", Kind: "serve", Fs: "b:", Name: "webdav:127.0.0.1:8080", RC: rc},
				{ID: "s2", Kind: "serve", Fs: "c:", Name: "http:127.0.0.1:8081"}, // restarting
			}
		},
		func() []Target {
			return []Target{{ID: "m1", Kind: "mount", Fs: "a:", Name: "/mnt/a", RC: rc}}
		},
	)
	list := s.List()
	if len(list) != 2 || list[0].ID != "m1" || list[1].ID != "s1" {
		t.Fatalf("list %+v", list)
	}
	if err := s.Forget(context.Background(), "s2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("forget a serve that is not running: %v", err)
	}
}
