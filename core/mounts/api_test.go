package mounts

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

func TestNeedsPasswordIsAPrecondition(t *testing.T) {
	err := fmt.Errorf("starting: %w", &children.ConfigError{Path: "/x/rclone.conf", Err: config.ErrNeedsPassword})
	if got := rclone.ErrorOf(err).Code; got != errs.CodePrecondition {
		t.Fatalf("got %v (%s), want precondition", err, got)
	}
}

func TestStartReady(t *testing.T) {
	f := newFixture(t)
	api := NewAPI(late.Of(f.s))
	src, mp := f.place("ready")
	row, err := api.StartReady(f.ctx, operations.MountArgs{Source: src, Destination: mp})
	if err != nil || row.State != string(children.StatusRunning) || row.MountPoint != mp {
		t.Fatalf("got %+v, %v\n%s", row, err, f.lines.dump())
	}
	if err := api.Stop(f.ctx, row.ID); err != nil {
		t.Fatal(err)
	}

	f.fake("--fake-fail=the remote said no")
	src, mp = f.place("refused")
	if _, err := api.StartReady(f.ctx, operations.MountArgs{Source: src, Destination: mp}); err == nil ||
		!strings.Contains(err.Error(), "the remote said no") {
		t.Fatalf("a failed start: %v", err)
	}
	if _, err := api.StartReady(f.ctx, operations.MountArgs{Source: src}); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("a form that Start refuses: %v", err)
	}
}
