package favorites

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// List returns every favorite, oldest first.
func (a *API) List(ctx context.Context) ([]Favorite, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]Favorite, error) { return s.List(ctx) })
}

// Add adds a favorite. A favorite that already exists keeps its original time.
func (a *API) Add(ctx context.Context, path string) (Favorite, error) {
	return late.Call(ctx, a.s, func(s *Service) (Favorite, error) { return s.Add(ctx, path) })
}

func (a *API) Remove(ctx context.Context, path string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Remove(ctx, path) })
}
