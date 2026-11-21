package notifications

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

func (a *API) Catalog(ctx context.Context) (NotificationCatalog, error) {
	return late.Call(ctx, a.s, func(s *Service) (NotificationCatalog, error) { return s.Catalog(), nil })
}

// ListTargets lists the targets, with their last errors in the app's language.
func (a *API) ListTargets(ctx context.Context) ([]NotificationTarget, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]NotificationTarget, error) {
		list, err := s.Targets(ctx)
		for i := range list {
			list[i] = list[i].local()
		}
		return list, err
	})
}

// Check returns the target form's field errors, as a save would refuse them, for the page to
// show as the user types. A url that another target already uses is only refused by the save.
func (a *API) Check(_ context.Context, in TargetInput) (Problems, error) {
	return in.Problems(), nil
}

func (a *API) CreateTarget(ctx context.Context, in TargetInput) (NotificationTarget, error) {
	return late.Call(ctx, a.s, func(s *Service) (NotificationTarget, error) {
		t, err := s.Create(ctx, in)
		return t.local(), err
	})
}

// UpdateTarget replaces a target. Its last error comes back in the app's language.
func (a *API) UpdateTarget(ctx context.Context, id string, in TargetInput) (NotificationTarget, error) {
	return late.Call(ctx, a.s, func(s *Service) (NotificationTarget, error) {
		t, err := s.Update(ctx, id, in)
		return t.local(), err
	})
}

func (a *API) DeleteTarget(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Delete(ctx, id) })
}

func (a *API) SetTargetEnabled(ctx context.Context, id string, enabled bool) error {
	return a.s.Do(ctx, func(s *Service) error { return s.SetEnabled(ctx, id, enabled) })
}

func (a *API) Test(ctx context.Context, in TestInput) (Outcome, error) {
	return late.Call(ctx, a.s, func(s *Service) (Outcome, error) { return s.Test(ctx, in) })
}

func (a *API) GetSmtp(ctx context.Context) (SMTPView, error) {
	return late.Call(ctx, a.s, func(s *Service) (SMTPView, error) { return s.SMTP(ctx) })
}

func (a *API) SetSmtp(ctx context.Context, in SMTPInput) (SMTPView, error) {
	return late.Call(ctx, a.s, func(s *Service) (SMTPView, error) { return s.SetSMTP(ctx, in) })
}

func (a *API) TestSmtp(ctx context.Context, to string) (Outcome, error) {
	return late.Call(ctx, a.s, func(s *Service) (Outcome, error) { return s.TestSMTP(ctx, to) })
}

// ReportUpdate sends app.update-available when the shell's updater finds a new release.
func (a *API) ReportUpdate(ctx context.Context, u UpdateAvailable) error {
	return a.s.Do(ctx, func(s *Service) error {
		s.Notify(context.WithoutCancel(ctx), NotificationEventUpdateAvailable, u)
		return nil
	})
}
