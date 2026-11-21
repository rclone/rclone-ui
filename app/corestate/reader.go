package corestate

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/tunnel"
	"github.com/rclone/rclone-ui/core/vfs"
)

// APIReader reads the core's state through the APIs that the pages call too.
func APIReader(apis *core.APIs) Reader { return apiReader{apis} }

type apiReader struct{ apis *core.APIs }

func (r apiReader) Remotes(ctx context.Context) ([]engine.Remote, error) {
	list, err := r.apis.Remotes.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]engine.Remote, 0, len(list))
	for _, rm := range list {
		var features map[string]bool
		if rm.Fsinfo != nil {
			features = rm.Fsinfo.Features
		}
		out = append(out, engine.Remote{Name: rm.Name, Type: rm.Type, Features: features})
	}
	return out, nil
}

func (r apiReader) Mounts(ctx context.Context) ([]mounts.MountRow, error) {
	return r.apis.Mounts.List(ctx, false)
}

func (r apiReader) Serves(ctx context.Context) ([]serves.ServeRow, error) {
	return r.apis.Serves.List(ctx)
}

func (r apiReader) Vfs(ctx context.Context) ([]vfs.VFS, error) { return r.apis.Vfs.List(ctx) }

func (r apiReader) Tunnel(ctx context.Context) (bool, error) {
	st, err := r.apis.Tunnel.Status(ctx)
	return st.State != tunnel.StateOff, err
}

func (r apiReader) ActiveTransfers(ctx context.Context) ([]transfers.Transfer, error) {
	return r.apis.Transfers.ListActive(ctx)
}

func (r apiReader) EndedTransfers(ctx context.Context, limit int) ([]transfers.Transfer, error) {
	page, err := r.apis.Transfers.ListEnded(ctx, transfers.EndedQuery{Limit: limit})
	return page.Items, err
}

func (r apiReader) ServeTypes(context.Context) ([]string, error) { return r.apis.Serves.Types(), nil }
