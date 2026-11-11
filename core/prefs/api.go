package prefs

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// Get returns the stored JSON of each requested key, or of every key when none are given. A key
// that was never set is left out.
func (a *API) Get(ctx context.Context, keys []string) (map[string]string, error) {
	return late.Call(ctx, a.s, func(s *Service) (map[string]string, error) { return s.Get(ctx, keys) })
}

// Set stores the JSON value under key. An empty value removes the key.
func (a *API) Set(ctx context.Context, key, value string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Set(ctx, key, value) })
}
