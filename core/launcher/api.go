package launcher

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// Record records that key was picked for query ("" for the empty query).
func (a *API) Record(ctx context.Context, key, query string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Record(ctx, key, query) })
}

// Usage returns every key's history, the most recently used first.
func (a *API) Usage(ctx context.Context) ([]Usage, error) {
	return late.CallValues(ctx, a.s, func(s *Service) ([]*Usage, error) { return s.Usage(ctx) })
}

// Forget deletes key's history. An empty key deletes the history of every key.
func (a *API) Forget(ctx context.Context, key string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Forget(ctx, key) })
}
