package tunnel

import (
	"context"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
)

// TunnelStatus is the tunnel as the Mobile & Remote Control window shows it, with its address and
// credentials while it is on.
type TunnelStatus struct {
	State State  `json:"state"`
	URL   string `json:"url"`
	User  string `json:"user"`
	Pass  string `json:"pass"`
	// Error explains why the last start failed, or why the tunnel went down, in the app's
	// language.
	Error string `json:"error"`
}

func toStatus(st Status) TunnelStatus {
	out := TunnelStatus{State: st.State, Error: i18n.Localize(st.Err)}
	if st.State == StateOn {
		out.URL, out.User, out.Pass = st.URL, st.User, st.Pass
	}
	return out
}

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

func (a *API) Status(ctx context.Context) (TunnelStatus, error) {
	return late.Call(ctx, a.s, func(s *Service) (TunnelStatus, error) { return toStatus(s.Status()), nil })
}

func (a *API) Start(ctx context.Context) (TunnelStatus, error) {
	return late.Call(ctx, a.s, func(s *Service) (TunnelStatus, error) {
		st, err := s.Start(ctx)
		if err != nil {
			return TunnelStatus{}, err
		}
		return toStatus(st), nil
	})
}

func (a *API) Stop(ctx context.Context) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Stop(ctx) })
}
