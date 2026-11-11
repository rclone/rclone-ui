package host

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/transfers"
)

// coreAPIs lists folders for completion and provides the services that actions call. The core's
// state doesn't come through it: the launcher reads that from the store.
type coreAPIs struct{ apis *core.APIs }

func (r coreAPIs) List(ctx context.Context, dir string, page func([]engine.Entry)) error {
	return r.apis.ListFolder(ctx, dir, func(rows []browse.Row) {
		entries := make([]engine.Entry, len(rows))
		for i, row := range rows {
			entries[i] = engine.Entry{Name: row.Name, Path: row.Path, Dir: row.IsDir || row.IsBucket}
		}
		page(entries)
	})
}

func (r coreAPIs) Services() engine.Services {
	return engine.Services{Mounts: r.apis.Mounts, Serves: r.apis.Serves, Vfs: r.apis.Vfs,
		Transfers: launcherTransfers{r.apis.Transfers, r.apis}, Everything: r.apis}
}

// launcherTransfers holds the transfer actions of the launcher: the pages' API, and the core's
// cleanup, which the pages can't start.
type launcherTransfers struct {
	*transfers.API
	apis *core.APIs
}

func (t launcherTransfers) StartCleanup(ctx context.Context, remote string) (transfers.Started, error) {
	return t.apis.StartCleanup(ctx, remote)
}
