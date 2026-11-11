package mounts

import (
	"context"
	"errors"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// MountRow is a running mount as the pages see it.
type MountRow struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	MountPoint string `json:"mountPoint"`
	PID        int    `json:"pid"`
	// State is starting, running, restarting, failed or stopped.
	State          string `json:"state"`
	Error          string `json:"error"`
	UploadsPending int    `json:"uploadsPending"`
	Automount      bool   `json:"automount"`
	// Restart is true when a remote it mounts changed after it started, so it needs to be
	// mounted again for the change to apply.
	Restart bool `json:"restart"`
}

// StoppedRow is a stopped mount that has uploads waiting.
type StoppedRow struct {
	Folder     string               `json:"folder"`
	Source     string               `json:"source"`
	MountPoint string               `json:"mountPoint"`
	Args       operations.MountArgs `json:"args"`
	// Pending is the number of files waiting, or -1 when unknown.
	Pending int64 `json:"pending"`
}

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// Row converts a mount into the row the pages see, with its error in the app's language.
func Row(m Mount) MountRow {
	return MountRow{
		ID: m.ID, Source: m.Source, MountPoint: m.MountPoint,
		PID: m.PID, State: string(m.State), Error: i18n.Localize(m.Error),
		UploadsPending: m.UploadsPending, Automount: m.Automount, Restart: m.Restart,
	}
}

// Support reports whether this computer can mount right now, with the reason in the app's
// language.
func (a *API) Support(ctx context.Context) (Support, error) {
	return late.Call(ctx, a.s, func(s *Service) (Support, error) { return s.Support().localized(), nil })
}

// InstallWinFsp installs WinFsp with the installer next to the app, when Support says it can.
// Windows asks the user for administrator rights, and the error is canceled when they say no.
func (a *API) InstallWinFsp(ctx context.Context) error {
	return a.s.Do(ctx, func(s *Service) error { return s.InstallWinFsp(ctx) })
}

// List lists the running mounts, with their upload queues when uploads is set.
func (a *API) List(ctx context.Context, uploads bool) ([]MountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]MountRow, error) {
		list := s.List()
		if uploads {
			list = s.ListUploads(ctx)
		}
		out := make([]MountRow, len(list))
		for i, m := range list {
			out[i] = Row(m)
		}
		return out, nil
	})
}

func (a *API) Start(ctx context.Context, args operations.MountArgs) (MountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (MountRow, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return MountRow{}, err
		}
		return row(s.Start(ctx, args))
	})
}

// StartReady starts a mount from a form, as Start does, and returns once the mount is ready, or
// with why its first start failed. A page learns both from mounts.changed. An agent's tool gets
// no events, so it waits here instead. A mount that is still starting when ctx ends comes back as
// it is.
func (a *API) StartReady(ctx context.Context, args operations.MountArgs) (MountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (MountRow, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return MountRow{}, err
		}
		// The subscription comes before the start, so that none of the mount's events is missed.
		var events <-chan bus.Event
		if s.o.Bus != nil {
			sub := s.o.Bus.Subscribe()
			defer sub.Close()
			events = sub.C
		}
		m, err := s.Start(ctx, args)
		if err != nil {
			return MountRow{}, err
		}
		for events != nil {
			select {
			case <-ctx.Done():
				events = nil
			case ev, ok := <-events:
				d, mine := ev.Data.(bus.MountsChangedData)
				switch {
				case !ok:
					events = nil // the subscription fell behind, so the list says how the mount is
				case !mine || d.ID != m.ID:
				case d.State == string(children.StatusRunning):
					events = nil
				case d.State == string(children.StatusFailed) && d.Error != "":
					return MountRow{}, errors.New(d.Error)
				case d.State == string(children.StatusFailed) || d.State == string(children.StatusStopped):
					return MountRow{}, ErrNotFound
				}
			}
		}
		for _, now := range s.List() {
			if now.ID == m.ID {
				return Row(now), nil
			}
		}
		return MountRow{}, ErrNotFound // it failed, and its event was missed
	})
}

// Command returns the page's mount for a script: the rclone command that the app runs, without
// the flags that only the app's own mounts need, and the same mount as a program for rclone-sdk.
// Nothing is mounted.
func (a *API) Command(ctx context.Context, args operations.MountArgs) (operations.Script, error) {
	return late.Call(ctx, a.s, func(s *Service) (operations.Script, error) {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return operations.Script{}, err
		}
		return operations.MountScript(args, s.env(0), rclone.ScriptConfig())
	})
}

// Check returns the refusal of the page's form that Start would give before it mounts anything,
// or nil. The page calls it as the user types. The mount point's own checks, such as whether it
// is in use, are left to Start.
func (a *API) Check(ctx context.Context, args operations.MountArgs) error {
	return a.s.Do(ctx, func(s *Service) error {
		if err := operations.StoreMapper(&args.Options); err != nil {
			return err
		}
		// Start picks the NFS port. Any port reads the form the same way.
		_, err := operations.MountCommand(args, s.env(1))
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

// Stopped lists the stopped mounts that have uploads waiting.
func (a *API) Stopped(ctx context.Context) ([]StoppedRow, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]StoppedRow, error) {
		list, err := s.Stopped(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]StoppedRow, len(list))
		for i, m := range list {
			pending := int64(-1)
			if m.Pending != nil {
				pending = *m.Pending
			}
			out[i] = StoppedRow{
				Folder: m.Folder, Source: m.Source, MountPoint: m.MountPoint,
				Args: m.Args, Pending: pending,
			}
		}
		return out, nil
	})
}

func (a *API) MountAgain(ctx context.Context, folder string) (MountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (MountRow, error) { return row(s.MountAgain(ctx, folder)) })
}

// Discard deletes a stopped mount's waiting uploads.
func (a *API) Discard(ctx context.Context, folder string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Discard(ctx, folder) })
}

// ListAutomounts lists the automounts, with whether each is mounted now.
func (a *API) ListAutomounts(ctx context.Context) ([]AutomountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]AutomountRow, error) {
		out, err := s.Automounts(ctx)
		if out == nil && err == nil {
			out = []AutomountRow{}
		}
		return out, err
	})
}

// SaveAutomount creates an automount (without an id) or edits one. A refused field comes back
// as a field error on remote, remotePath, mountPoint or one of the option groups.
func (a *API) SaveAutomount(ctx context.Context, m Automount) (Automount, error) {
	return late.Call(ctx, a.s, func(s *Service) (Automount, error) { return s.SaveAutomount(ctx, m) })
}

// DeleteAutomount deletes an automount. A mount that it started keeps running.
func (a *API) DeleteAutomount(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.DeleteAutomount(ctx, id) })
}

func (a *API) MountAutomount(ctx context.Context, id string) (MountRow, error) {
	return late.Call(ctx, a.s, func(s *Service) (MountRow, error) { return row(s.MountAutomount(ctx, id)) })
}

func row(m Mount, err error) (MountRow, error) {
	if err != nil {
		return MountRow{}, err
	}
	return Row(m), nil
}
