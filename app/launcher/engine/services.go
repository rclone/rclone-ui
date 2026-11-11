package engine

import (
	"context"

	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/transfers"
)

// Services are the parts of the core that actions call. The fields are nil while the core isn't
// running.
type Services struct {
	Mounts Stopper
	Serves Stopper
	Vfs    interface {
		Forget(ctx context.Context, id string) error
	}
	Transfers Transfers
	// Everything is Stop Everything, which stops what the core runs (see core.Core.StopAll).
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
	// StartCleanup starts the cleanup of remote (`gdrive:`) as a transfer.
	StartCleanup(ctx context.Context, remote string) (transfers.Started, error)
}
