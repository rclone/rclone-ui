package templates

import (
	"context"
	"runtime"
	"slices"

	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
)

type API struct{ s *late.Value[*Service] }

// NewAPI creates the API. s provides the service once the core has started.
func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// List returns every template, in the list's order, and every tag that a template can have.
func (a *API) List(ctx context.Context) (List, error) {
	return late.Call(ctx, a.s, func(s *Service) (List, error) {
		ts, err := s.List(ctx)
		if err != nil {
			return List{}, err
		}
		return List{Templates: late.Values(ts), Tags: slices.Clone(Tags)}, nil
	})
}

// Save creates or replaces a template.
func (a *API) Save(ctx context.Context, t Template) (Template, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*Template, error) { return s.Save(ctx, &t) })
}

// DeleteMany removes the templates that the page selected, and returns how many it removed.
func (a *API) DeleteMany(ctx context.Context, ids []string) (int, error) {
	return late.Call(ctx, a.s, func(s *Service) (int, error) { return s.Delete(ctx, ids) })
}

// Groups returns the options of the template saved under id sorted into the groups of op's form,
// as its page applies them, and the options that the form leaves out. serve is the Serve page's
// type, or "" for every type.
func (a *API) Groups(ctx context.Context, id string, op operations.Operation, serve string) (Applied, error) {
	return late.Call(ctx, a.s, func(s *Service) (Applied, error) { return s.Groups(ctx, id, op, serve) })
}

// Export returns the export file of the templates that the page selected, with each template's
// options as a command line for this computer's shell.
func (a *API) Export(ctx context.Context, ids []string) (string, error) {
	return late.Call(ctx, a.s, func(s *Service) (string, error) { return s.Export(ctx, ids, runtime.GOOS) })
}
