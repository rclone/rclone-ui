package transfers

import (
	"context"
	"runtime"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// StartOptions are the options that every start accepts, besides the operation's own form.
type StartOptions struct {
	DryRun bool `json:"dryRun"`
	// Origin is where the transfer was started from: OriginPage or OriginCommander. A template's
	// run starts with StartTemplate, and only watchers and schedules start their own runs.
	Origin OriginKind `json:"origin"`
	// Preset is the page's form as the page saved it. Duplicate uses it.
	Preset *operations.Form `json:"preset,omitempty"`
}

type API struct {
	s         *late.Value[*Service]
	templates *late.Value[Templates]
}

// Templates gives the form that runs a saved template as one of its tags, and the template's
// name (templates.Service).
type Templates interface {
	Run(ctx context.Context, id string, tag operations.Operation) (form operations.Form, name string, err error)
}

func NewAPI(s *late.Value[*Service], t *late.Value[Templates]) *API {
	return &API{s: s, templates: t}
}

// started builds the result of a start. When the transfer was recorded before the start failed,
// the error carries the recorded transfer. A first bisync that rclone refused, because the two
// folders have no baseline yet, is a precondition (operations.WhatBisyncBaseline), which the
// Bisync page answers by offering a resync.
func started(st Started, err error) (Started, error) {
	if err != nil {
		if st.ID != "" {
			e := errs.Launched(err, st.ID, st.Seq)
			if operations.IsFirstRun(err.Error()) {
				e.Code, e.What = errs.CodePrecondition, operations.WhatBisyncBaseline
			}
			return Started{}, e
		}
		return Started{}, err
	}
	return st, nil
}

// Start starts the transfer of a page's form: a copy, move, sync, bisync, delete, purge, download
// or save. The Commander's renames and folder deletes start through the files service, and the
// launcher's cleanup through the core, so Start refuses them.
func (a *API) Start(ctx context.Context, f operations.Form, o StartOptions) (Started, error) {
	if !startsFromPage(f.Operation) {
		return Started{}, errs.Field("operation", "This operation doesn’t start from a page.")
	}
	if o.Origin != OriginPage && o.Origin != OriginCommander {
		return Started{}, errs.Field("origin", "A transfer starts from a page or the Commander.")
	}
	return late.Call(ctx, a.s, func(s *Service) (Started, error) {
		return started(s.Start(ctx, Spec{Form: f, Origin: Origin{Kind: o.Origin}, DryRun: o.DryRun, Preset: o.Preset}))
	})
}

// Check returns Start's refusal of a page's form, as far as it can be told without asking rclone
// about the paths (operations.CheckForm), or nil. The pages call it as the user types. A refused
// option comes back on its group's field (options.config…).
func (a *API) Check(_ context.Context, f operations.Form) error {
	if !startsFromPage(f.Operation) {
		return errs.Field("operation", "This operation doesn’t start from a page.")
	}
	return operations.CheckForm(f)
}

func startsFromPage(op operations.Operation) bool {
	switch op {
	case operations.OperationCopy, operations.OperationMove, operations.OperationSync,
		operations.OperationBisync, operations.OperationDelete, operations.OperationPurge,
		operations.OperationDownload, operations.OperationSave:
		return true
	}
	return false
}

// Landings says where each source of a copy or a move would end up in the destination, for the
// page to show under it. operation is copy or move. It reads whether each source is a file or a
// folder, as Start does, and returns Start's refusal for a form it would refuse.
func (a *API) Landings(ctx context.Context, operation operations.Operation, args operations.CopyArgs) ([]operations.Landing, error) {
	var f operations.Form
	switch operation {
	case operations.OperationCopy:
		f = args.Form()
	case operations.OperationMove:
		f = operations.MoveArgs(args).Form()
	default:
		return nil, errs.Field("operation", "Only a copy or a move has landings.")
	}
	return late.Call(ctx, a.s, func(s *Service) ([]operations.Landing, error) { return s.Landings(ctx, f) })
}

// Command returns what Start would run for the form of an operation page (copy, move, sync,
// bisync, delete, purge or download): one rclone command for each step of the transfer, for this
// computer's shell, and a program that runs the same steps with rclone-sdk. Nothing is started.
// It returns Start's refusal for a form that Start would refuse.
func (a *API) Command(ctx context.Context, f operations.Form) (operations.Script, error) {
	switch f.Operation {
	case operations.OperationCopy, operations.OperationMove, operations.OperationSync,
		operations.OperationBisync, operations.OperationDelete, operations.OperationPurge,
		operations.OperationDownload:
	default:
		return operations.Script{}, errs.Field("operation", "Only an operation page's form has a command.")
	}
	return late.Call(ctx, a.s, func(s *Service) (operations.Script, error) {
		return s.Script(ctx, f, runtime.GOOS, rclone.ScriptConfig())
	})
}

// StartTemplate runs the template saved under id as tag, one of its tags, with the template's
// paths and options. The transfer's origin is the template, and its preset reopens the
// operation's page with the same form.
func (a *API) StartTemplate(ctx context.Context, id string, tag operations.Operation) (Started, error) {
	t, err := a.templates.Get(ctx)
	if err != nil {
		return Started{}, err
	}
	return late.Call(ctx, a.s, func(s *Service) (Started, error) {
		f, name, err := t.Run(ctx, id, tag)
		if err != nil {
			return Started{}, err
		}
		origin := Origin{Kind: OriginTemplate, ID: id, Name: name}
		return started(s.Start(ctx, Spec{Form: f, Origin: origin, Preset: &f}))
	})
}

// ListActive lists the transfers that have not ended, newest first.
func (a *API) ListActive(ctx context.Context) ([]Transfer, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]Transfer, error) {
		ts, err := s.Active(ctx)
		return localAll(ts), err
	})
}

// ListEnded returns a page of ended transfers, newest first, with their errors in the app's
// language. q.Before is the id of the last one shown, and q.After the latest end shown. q.State
// and q.Search narrow the list.
func (a *API) ListEnded(ctx context.Context, q EndedQuery) (EndedPage, error) {
	return late.Call(ctx, a.s, func(s *Service) (EndedPage, error) {
		page, err := s.Ended(ctx, q)
		page.Items = localAll(page.Items)
		return page, err
	})
}

// Get returns one transfer with its retries, its preset, and the errors that are not tied to a
// file, in the app's language.
func (a *API) Get(ctx context.Context, id string) (Detail, error) {
	return late.Call(ctx, a.s, func(s *Service) (Detail, error) {
		d, err := s.Get(ctx, id)
		if err != nil {
			return d, err
		}
		d.Transfer, d.General = d.Transfer.local(), localGeneral(d.General)
		return d, nil
	})
}

// IDOf returns the id of the transfer whose number is seq, the "#12" that the pages show. The
// agents' server calls it, so that an agent can name a transfer by its number.
func (a *API) IDOf(ctx context.Context, seq int64) (string, error) {
	return late.Call(ctx, a.s, func(s *Service) (string, error) { return s.IDOf(ctx, seq) })
}

// localAll returns transfers as a page sees them, with their errors in the app's language. A nil
// list stays nil.
func localAll(ts []Transfer) []Transfer {
	if ts == nil {
		return nil
	}
	out := make([]Transfer, len(ts))
	for i, t := range ts {
		out[i] = t.local()
	}
	return out
}

// Files returns a page of a transfer's files with one outcome, newest first. before is the last
// cursor shown.
func (a *API) Files(ctx context.Context, id string, outcome Outcome, before string, limit int) (FilesPage, error) {
	return late.Call(ctx, a.s, func(s *Service) (FilesPage, error) {
		return s.Files(ctx, id, FilesQuery{Outcome: outcome, Before: before, Limit: limit})
	})
}

// Live returns the current progress of the running transfers, by id. transfers.progress sends
// the same numbers every second while any transfer runs.
func (a *API) Live(ctx context.Context) (map[string]bus.TransferProgress, error) {
	return late.Call(ctx, a.s, func(s *Service) (map[string]bus.TransferProgress, error) { return s.Live(), nil })
}

// Stop stops a running transfer. It is recorded as stopped, never as failed.
func (a *API) Stop(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Stop(ctx, id) })
}

// Retryable returns the parts of an ended transfer that can be retried, with the errors in the
// app's language.
func (a *API) Retryable(ctx context.Context, id string) (Retryable, error) {
	return late.Call(ctx, a.s, func(s *Service) (Retryable, error) {
		r, err := s.Retryable(ctx, id)
		if err != nil {
			return r, err
		}
		return r.local(), nil
	})
}

// Retry starts a new transfer that retries some of an ended transfer's failures, with the same
// settings as the original. Each key is a RetryItem's Key. With no keys, it retries all of them.
func (a *API) Retry(ctx context.Context, id string, keys [][2]string) (Started, error) {
	return late.Call(ctx, a.s, func(s *Service) (Started, error) { return started(s.Retry(ctx, id, keys)) })
}

// Tracked returns the current state of the transfers that a page started, each with its most
// recent files. The Commander's bar uses it.
func (a *API) Tracked(ctx context.Context, ids []string) ([]TrackedTransfer, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]TrackedTransfer, error) {
		ts, err := s.Tracked(ctx, ids)
		for i := range ts {
			ts[i].Transfer = ts[i].Transfer.local()
		}
		return ts, err
	})
}
