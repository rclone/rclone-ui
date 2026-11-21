package vfs

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

// VFS is one running VFS, which belongs to a mount or a serve.
type VFS struct {
	ID string `json:"id"`
	// Kind is "mount" or "serve".
	Kind string `json:"kind"`
	// Fs is the remote that it reads.
	Fs string `json:"fs"`
	// Name is the mount point, or the serve's type and address.
	Name string `json:"name"`
}

// API gives the pages and the launcher access to the running VFSes and their caches.
type API struct{ s *late.Value[*Service] }

// NewAPI creates the API. s provides the service once the core has started.
func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// List lists the VFSes of the running mounts and serves.
func (a *API) List(ctx context.Context) ([]VFS, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]VFS, error) {
		out := []VFS{}
		for _, t := range s.List() {
			out = append(out, VFS{ID: t.ID, Kind: t.Kind, Fs: t.Fs, Name: t.Name})
		}
		return out, nil
	})
}

// Forget clears a VFS's directory cache, or the cache of every VFS when id is "".
func (a *API) Forget(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Forget(ctx, id) })
}
