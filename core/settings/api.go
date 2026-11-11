package settings

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

func (a *API) Get(ctx context.Context) (Settings, error) {
	return late.Call(ctx, a.s, func(s *Service) (Settings, error) { return s.Get(ctx) })
}

func (a *API) Update(ctx context.Context, p Patch) (UpdateResult, error) {
	return late.Call(ctx, a.s, func(s *Service) (UpdateResult, error) {
		st, restart, err := s.Update(ctx, p)
		if err != nil {
			return UpdateResult{}, err
		}
		return UpdateResult{Settings: st, RestartRequired: restart}, nil
	})
}

// TestProxy makes one request through an unsaved proxy and describes the response. It doesn't
// need the service, so it works before the core has started.
func (a *API) TestProxy(ctx context.Context, url string) (string, error) {
	return TestProxy(ctx, url)
}
