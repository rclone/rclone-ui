package files

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/transfers"
)

// RenameItem is one entry in a batch rename.
type RenameItem struct {
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	NewName string `json:"newName"`
}

// RenameResult is the new path of a renamed entry, and the transfer that renames a folder.
type RenameResult struct {
	Path string `json:"path"`
	// TransferID is the recorded transfer that renames a folder. It is empty for a file.
	TransferID string `json:"transferId"`
}

// API is the file actions API that the Commander calls to change entries in place.
type API struct{ s *late.Value[*Service] }

// NewAPI returns an API that waits for the service s to be set.
func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

func (a *API) Mkdir(ctx context.Context, path string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Mkdir(ctx, path) })
}

// IsFolder reports whether the entry at path is a folder. It fails when nothing is there.
func (a *API) IsFolder(ctx context.Context, path string) (bool, error) {
	return late.Call(ctx, a.s, func(s *Service) (bool, error) { return s.IsFolder(ctx, path) })
}

func (a *API) Rename(ctx context.Context, path string, isDir bool, newName string) (RenameResult, error) {
	return late.Call(ctx, a.s, func(s *Service) (RenameResult, error) {
		r, err := s.Rename(ctx, path, isDir, newName)
		if err != nil {
			return RenameResult{}, err
		}
		return RenameResult{Path: r.Path, TransferID: r.TransferID}, nil
	})
}

// Delete deletes a file, or starts a recorded transfer that deletes a folder. It returns the
// transfer, which is empty for a file.
func (a *API) Delete(ctx context.Context, path string, isDir bool) (transfers.Started, error) {
	return late.Call(ctx, a.s, func(s *Service) (transfers.Started, error) { return s.Delete(ctx, path, isDir) })
}

// BatchRename starts one recorded transfer that renames several entries, and returns it.
func (a *API) BatchRename(ctx context.Context, items []RenameItem) (transfers.Started, error) {
	return late.Call(ctx, a.s, func(s *Service) (transfers.Started, error) {
		in := make([]Item, len(items))
		for i, it := range items {
			in[i] = Item{Path: it.Path, IsDir: it.IsDir, NewName: it.NewName}
		}
		return s.BatchRename(ctx, in)
	})
}
