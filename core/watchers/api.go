package watchers

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// List returns every watcher, sorted by name, with its last error in the app's language.
func (a *API) List(ctx context.Context) ([]Watcher, error) {
	return late.CallValues(ctx, a.s, func(s *Service) ([]*Watcher, error) {
		ws, err := s.List(ctx)
		for _, w := range ws {
			w.local()
		}
		return ws, err
	})
}

func (a *API) Get(ctx context.Context, id string) (Watcher, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Watcher, error) {
		w, err := s.Get(ctx, id)
		return w.local(), err
	})
}

// Save creates a watcher (without an id) or edits one. A refused field comes back as a field
// error on name, pathA or pathB.
func (a *API) Save(ctx context.Context, in Input) (Watcher, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Watcher, error) {
		w, err := s.Save(ctx, in)
		return w.local(), err
	})
}

// Delete removes a watcher and stops its run. The folders and their files are left alone.
func (a *API) Delete(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Delete(ctx, id) })
}

// Pause stops a watcher from running every minute.
func (a *API) Pause(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Pause(ctx, id) })
}

// Resume runs a paused watcher every minute again, starting now.
func (a *API) Resume(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Resume(ctx, id) })
}

// SyncNow runs a watcher now, unless a run is in progress.
func (a *API) SyncNow(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.SyncNow(ctx, id) })
}

// Resync merges the two folders of a watcher once, newer wins, deleting nothing.
func (a *API) Resync(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Resync(ctx, id) })
}

// Force runs a watcher that stopped because many files were deleted in one folder once with
// bisync's force, which deletes the same files in the other folder.
func (a *API) Force(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Force(ctx, id) })
}
