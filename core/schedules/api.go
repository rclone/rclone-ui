package schedules

import (
	"context"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// List returns every schedule, sorted by name, each with its next run and its last error in the
// app's language.
func (a *API) List(ctx context.Context) ([]Schedule, error) {
	return late.CallValues(ctx, a.s, func(s *Service) ([]*Schedule, error) {
		list, err := s.List(ctx)
		for _, sc := range list {
			sc.local()
		}
		return list, err
	})
}

func (a *API) Get(ctx context.Context, id string) (Schedule, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Schedule, error) {
		sc, err := s.Get(ctx, id)
		return sc.local(), err
	})
}

// Save creates a schedule (without an id) or edits one. Only name and when are field errors. A
// form that a run would refuse comes back as one message.
func (a *API) Save(ctx context.Context, in Input) (Schedule, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Schedule, error) {
		sc, err := s.Save(ctx, in)
		return sc.local(), err
	})
}

// Duplicate copies a schedule as "{name} copy", paused.
func (a *API) Duplicate(ctx context.Context, id string) (Schedule, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Schedule, error) {
		sc, err := s.Duplicate(ctx, id)
		return sc.local(), err
	})
}

// Delete removes a schedule. Its past runs stay in History.
func (a *API) Delete(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Delete(ctx, id) })
}

// Pause stops a schedule's future runs.
func (a *API) Pause(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Pause(ctx, id) })
}

// Resume runs a paused schedule again, from now on.
func (a *API) Resume(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Resume(ctx, id) })
}

// RunNow runs a schedule at once, unless a run is in progress.
func (a *API) RunNow(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.RunNow(ctx, id) })
}

// MergeAgain merges a bisync's two folders once, newer wins, deleting nothing.
func (a *API) MergeAgain(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.MergeAgain(ctx, id) })
}

// Describe returns the next 3 times of a cron expression and the zone's abbreviation, or the
// problem with it.
func (a *API) Describe(ctx context.Context, when string) (Description, error) {
	return late.Call(ctx, a.s, func(s *Service) (Description, error) { return s.Describe(when), nil })
}

// FromTemplate returns the form that runs a template as one of its operations (tag), as the
// template's Run button would.
func (a *API) FromTemplate(ctx context.Context, id string, tag operations.Operation) (operations.Form, error) {
	return late.Call(ctx, a.s, func(s *Service) (operations.Form, error) { return s.FromTemplate(ctx, id, tag) })
}

// LeftOff returns the names of what a schedule saved from the form leaves off, because it is for
// a single run: "Dry run", "Resync" and "Force", each when it is on, in the app's language.
func (a *API) LeftOff(_ context.Context, f operations.Form) ([]string, error) {
	names, err := LeftOff(f)
	for i, name := range names {
		names[i] = optionLabel(name)
	}
	return names, err
}

// optionLabel returns the label of an option that LeftOff names, in the app's language.
func optionLabel(name string) string {
	switch name {
	case "Dry run":
		// i18n: An option of a transfer: it only shows what would change.
		return i18n.T("Dry run")
	case "Resync":
		// i18n: An option of a bisync: it merges the two folders again.
		return i18n.T("Resync")
	case "Force":
		// i18n: An option of a bisync: it runs even when many files were deleted.
		return i18n.T("Force")
	}
	return name
}
