package catalog

import (
	"context"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
)

// Every method but Values answers at once, before the core has started. Values reads the values
// that rclone's init sets, so it waits for the core.
type API struct {
	s     *Service
	ready *late.Value[struct{}]
}

func NewAPI(s *Service, ready *late.Value[struct{}]) *API { return &API{s: s, ready: ready} }

// Get returns the catalog with rclone's text in the app's language. The backends come without
// their options.
func (a *API) Get(context.Context) (Catalog, error) {
	return *a.s.SummaryIn(i18n.Language()), nil
}

// English returns the catalog as Get does, but always with rclone's English text.
func (a *API) English(context.Context) (Catalog, error) { return *a.s.Summary(), nil }

func (a *API) Values(ctx context.Context) (Values, error) {
	return late.CallValue(ctx, a.ready, func(struct{}) (*Values, error) { return a.s.Values(ctx), nil })
}

// Backend returns one backend's options for a provider, with rclone's text in the app's
// language.
func (a *API) Backend(_ context.Context, typ, provider string) (BackendOptions, error) {
	return value(a.s.BackendIn(typ, provider, i18n.Language()))
}

// ParseCommand reads a pasted command line into option groups. The reasons for the flags that it
// skips are in the app's language.
func (a *API) ParseCommand(_ context.Context, command string) (ParsedCommand, error) {
	out, err := value(a.s.ParseCommand(command))
	if err == nil {
		out.Skipped = LocalSkipped(out.Skipped)
	}
	return out, err
}

func value[T any](p *T, err error) (T, error) {
	if p == nil {
		var zero T
		return zero, err
	}
	return *p, err
}

// SortOptions sorts a template's flat options into the catalog's groups. serve is a serve's type,
// or "" for every type. The options that no group takes come back as skipped, with the reason in
// the app's language.
func (*API) SortOptions(_ context.Context, options Group, serve string) (Sorted, error) {
	out := SortOptions(options, serve)
	out.Skipped = LocalSkipped(out.Skipped)
	return out, nil
}
