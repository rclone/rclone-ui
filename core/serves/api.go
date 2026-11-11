package serves

import (
	"context"
	"errors"
	"runtime"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// ServeRow is a running serve as the pages see it.
type ServeRow struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Addr   string `json:"addr"`
	// Args is the form the serve was started with, with its address resolved.
	Args operations.ServeArgs `json:"args"`
	PID  int                  `json:"pid"`
	// State is starting, running or restarting.
	State string `json:"state"`
	Error string `json:"error"`
	// Restart is true when a remote it serves changed after it started, so it needs to be
	// served again for the change to apply.
	Restart bool `json:"restart"`
}

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// Row converts a serve into the row the pages see, with its error in the app's language.
func Row(v Serve) ServeRow {
	return ServeRow{
		ID: v.ID, Type: v.Type, Source: v.Source, Addr: v.Addr, Args: v.Args,
		PID: v.PID, State: string(v.State), Error: i18n.Localize(v.Error), Restart: v.Restart,
	}
}

func (a *API) List(ctx context.Context) ([]ServeRow, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]ServeRow, error) {
		list := s.List()
		out := make([]ServeRow, len(list))
		for i, v := range list {
			out[i] = Row(v)
		}
		return out, nil
	})
}

func (a *API) Start(ctx context.Context, args operations.ServeArgs) (ServeRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (ServeRow, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return ServeRow{}, err
		}
		v, err := s.Start(ctx, args)
		if err != nil {
			return ServeRow{}, err
		}
		return Row(v), nil
	})
}

// StartReady starts a serve from a form, as Start does, and returns once its address accepts
// connections, or with why its first start failed. A page learns both from serves.changed. An
// agent's tool gets no events, so it waits here instead. A serve that is still starting when ctx
// ends comes back as it is.
func (a *API) StartReady(ctx context.Context, args operations.ServeArgs) (ServeRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (ServeRow, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return ServeRow{}, err
		}
		// The subscription comes before the start, so that none of the serve's events is missed.
		var events <-chan bus.Event
		if s.o.Bus != nil {
			sub := s.o.Bus.Subscribe()
			defer sub.Close()
			events = sub.C
		}
		v, err := s.Start(ctx, args)
		if err != nil {
			return ServeRow{}, err
		}
		for events != nil {
			select {
			case <-ctx.Done():
				events = nil
			case ev, ok := <-events:
				d, mine := ev.Data.(bus.ServesChangedData)
				switch {
				case !ok:
					events = nil // the subscription fell behind, so the list says how the serve is
				case !mine || d.ID != v.ID:
				case d.State == string(children.StatusRunning):
					events = nil
				case d.State == string(children.StatusFailed) && d.Error != "":
					return ServeRow{}, errors.New(d.Error)
				case d.State == string(children.StatusFailed) || d.State == string(children.StatusStopped):
					return ServeRow{}, ErrNotFound
				}
			}
		}
		for _, now := range s.List() {
			if now.ID == v.ID {
				return Row(now), nil
			}
		}
		return ServeRow{}, ErrNotFound // it failed, and its event was missed
	})
}

// Command returns the page's serve for a script: the rclone command that the app runs, with the
// credentials set as variables before it as the app sets them, and the same serve as a program
// for rclone-sdk. Nothing is served.
func (a *API) Command(ctx context.Context, args operations.ServeArgs) (operations.Script, error) {
	return late.Call(ctx, a.s, func(s *Service) (operations.Script, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return operations.Script{}, err
		}
		return operations.ServeScript(args, operations.ServeEnv{Exe: s.o.Executable}, runtime.GOOS, rclone.ScriptConfig())
	})
}

// Check returns the refusal of the page's form that Start would give before it serves anything,
// or nil. The page calls it as the user types.
func (a *API) Check(ctx context.Context, args operations.ServeArgs) error {
	return a.s.Do(ctx, func(s *Service) error {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return err
		}
		_, err := operations.ServeCommand(args, operations.ServeEnv{Exe: s.o.Executable})
		return err
	})
}

func (a *API) Stop(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Stop(ctx, id) })
}

func (a *API) StopAll(ctx context.Context) error {
	return a.s.Do(ctx, func(s *Service) error {
		_, err := s.StopAll(ctx)
		return err
	})
}

// Types lists the serve types that this build of rclone offers, in rclone's order.
func (a *API) Types() []string { return rclone.ServeTypes() }
