package engine

import (
	"context"

	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/transfers"
)

type Services struct {
	Mounts Stopper
	Serves Stopper
	Vfs    interface {
		Forget(ctx context.Context, id string) error
	}
	Transfers  Transfers
	Everything interface {
		StopAll(ctx context.Context) (core.StopSummary, error)
	}
}

type Stopper interface {
	Stop(ctx context.Context, id string) error
	StopAll(ctx context.Context) error
}

type Transfers interface {
	Stop(ctx context.Context, id string) error
	StartCleanup(ctx context.Context, remote string) (transfers.Started, error)
}
