package watchers

import (
	"context"
	"errors"
	"time"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/walk"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/runs"
	"github.com/rclone/rclone-ui/core/transfers"
)

type mode int

const (
	modeNormal mode = iota
	modeNow
	modeResync
	modeForce
)

type state struct {
	streak  *notifications.Streak
	failing bool
	merge   bool
}

type run = runs.Run[mode, runData]

type runData struct {
	a, b     string
	resync   bool
	sync     bool
	refilled bool
}

func (s *Service) stateOf(id string) *state {
	st := s.states[id]
	if st == nil {
		st = &state{streak: notifications.NewStreak(s.o.Notifier, notifications.NotificationEventWatcherFailed, &watcherDesktop)}
		s.states[id] = st
	}
	return st
}

func (s *Service) Run(ctx context.Context) {
	s.tick(ctx)
	t := time.NewTicker(s.o.Tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Service) tick(ctx context.Context) {
	s.runs.FreeStale(ctx)
	ws, err := s.readAll(ctx)
	if err != nil {
		if ctx.Err() == nil {
			s.log.ErrorContext(ctx, "reading the watchers", "error", err)
		}
		return
	}
	for _, w := range ws {
		if !w.Paused && w.Attention == "" {
			s.kick(w.ID, modeNormal)
		}
	}
}

func (s *Service) Shutdown() { s.runs.Shutdown() }

func (s *Service) kick(id string, m mode) {
	s.mu.Lock()
	s.stateOf(id)
	s.mu.Unlock()
	if m == modeResync || m == modeForce {
		s.runs.Queue(id, m)
	} else {
		s.runs.Kick(id, m)
	}
	if m == modeResync {
		s.changed()
	}
}

func resyncing(current map[string]runs.Status[mode], id string) bool {
	st, ok := current[id]
	return ok && (st.Mode == modeResync || st.Queued && st.Next == modeResync)
}

func (s *Service) bisyncParams(r *run) operations.BisyncSwitches {
	most := bisync.DefaultMaxDelete
	p := operations.UnattendedBisync(operations.BisyncSwitches{
		MaxDelete: &most, ConflictResolve: "newer", ConflictLoser: "num", CreateEmptySrcDirs: true,
	}, r.Data.resync, s.o.Workdir)
	p.Force = r.Mode == modeForce
	return p
}

type owner Service

func (o *owner) Start(ctx context.Context, id string, r *run, end transfers.Owner) (transfers.Started, bool, error) {
	s := (*Service)(o)
	w, err := s.read(ctx, id)
	switch {
	case err != nil:
		if !errors.Is(err, ErrNotFound) {
			s.log.ErrorContext(ctx, "reading a watcher to run", "watcher", id, "error", err)
		}
		return transfers.Started{}, false, nil
	case r.Mode == modeNormal && w.Paused, r.Mode <= modeNow && w.Attention != "",
		r.Mode == modeForce && w.Attention != AttentionDeletes && w.Attention != AttentionEmptied,
		r.Mode == modeForce && w.Attention == AttentionEmptied && w.DeletedSide == "":
		return transfers.Started{}, false, nil
	}
	s.mu.Lock()
	merge := s.states[id] != nil && s.states[id].merge
	s.mu.Unlock()
	r.Data.a, r.Data.b = w.PathA, w.PathB
	if r.Mode == modeForce && w.Attention == AttentionEmptied {
		if err := s.stillEmpty(ctx, w); err != nil {
			r.Data.refilled = errors.Is(err, errRefilled)
			return transfers.Started{}, true, err
		}
	}
	// A force never merges: a merge would bring back the files it is meant to delete.
	r.Data.resync = r.Mode == modeResync || (!w.Baselined || merge) && r.Mode != modeForce
	started, err := s.o.Transfers.Start(ctx, transfers.Spec{
		Form: s.runArgs(w, r), Origin: transfers.Origin{Kind: transfers.OriginWatcher, ID: w.ID, Name: w.Name},
		Owner: end,
	})
	return started, true, err
}

func (o *owner) Started(context.Context, string, *run, string) {}

func (o *owner) Refused(ctx context.Context, id string, r *run, err error) {
	now := time.Now().UnixMilli()
	o.Ended(ctx, id, r, transfers.Transfer{State: transfers.StateFailed, EndedAt: &now}.WithError(err))
}

func (o *owner) Changed() { (*Service)(o).changed() }

func (s *Service) runArgs(w *Watcher, r *run) operations.Form {
	if r.Mode == modeForce && w.Attention == AttentionEmptied {
		r.Data.sync = true
		from, to := w.PathA, w.PathB
		if w.DeletedSide == SideB {
			from, to = w.PathB, w.PathA
		}
		return operations.SyncArgs{Source: from, Destination: to}.Form()
	}
	outer := s.bisyncParams(r)
	return operations.BisyncArgs{
		Source: w.PathA, Destination: w.PathB, Options: operations.Groups{Outer: &outer},
	}.Form()
}

var errRefilled = errs.New("The folder that was empty has files again, so nothing was deleted. Resync merges the two folders and deletes nothing.")

func (s *Service) stillEmpty(ctx context.Context, w *Watcher) error {
	from := w.PathA
	if w.DeletedSide == SideB {
		from = w.PathB
	}
	var has bool
	_, err := rclone.Run(ctx, rclone.CallOpts{}, func(ctx context.Context) error {
		var err error
		has, err = hasFiles(ctx, from)
		return err
	})
	switch {
	case err != nil:
		// i18n: Why the files weren't deleted in the other folder, then the error from listing the folder.
		return errs.Errorf("The folder that was empty could not be checked, so nothing was deleted: %w", err)
	case has:
		return errRefilled
	}
	return nil
}

func hasFiles(ctx context.Context, path string) (bool, error) {
	f, err := cache.Get(ctx, path)
	if err != nil {
		return false, err
	}
	err = walk.ListR(ctx, f, "", false, -1, walk.ListObjects, func(entries fs.DirEntries) error {
		if len(entries) > 0 {
			return errFoundFile
		}
		return nil
	})
	if errors.Is(err, errFoundFile) {
		return true, nil
	}
	return false, err
}

var errFoundFile = errors.New("watchers: a file was found")

func (o *owner) Quiet(r *run, st transfers.State, errText string, s *transfers.Summary) bool {
	if !transfers.ChangedNothing(s) {
		return false
	}
	switch st {
	case transfers.StateCompleted:
		return r.Mode != modeResync && r.Mode != modeForce
	case transfers.StateFailed:
		return mergeAsked(r, errText)
	}
	return false
}

func mergeAsked(r *run, errText string) bool {
	trouble, _ := operations.BisyncTroubleOf(errText)
	return trouble == operations.TroubleMerge && !r.Data.resync && r.Mode != modeForce
}

func (o *owner) Ended(ctx context.Context, id string, r *run, t transfers.Transfer) (mode, bool) {
	s := (*Service)(o)
	s.mu.Lock()
	st := s.states[id]
	if st == nil {
		s.mu.Unlock()
		return 0, false
	}
	if t.State == transfers.StateFailed && mergeAsked(r, t.Error) {
		st.merge = true
		s.mu.Unlock()
		return modeNow, true
	}
	recovered := t.State == transfers.StateCompleted && st.failing
	switch t.State {
	case transfers.StateCompleted:
		st.failing = false
		if r.Data.resync {
			st.merge = false
		}
		if r.Data.sync {
			st.merge = true
		}
	case transfers.StateFailed:
		st.failing = true
	}
	streak := st.streak
	s.mu.Unlock()

	w, err := s.read(ctx, id)
	if err != nil {
		return 0, false
	}
	same := w.PathA == r.Data.a && w.PathB == r.Data.b
	at := time.Now().UnixMilli()
	if t.EndedAt != nil {
		at = *t.EndedAt
	}
	switch t.State {
	case transfers.StateCompleted:
		set, args := `last_run_at = ?, last_result = ?, last_error = ''`, []any{at, ResultSynced}
		switch {
		case !transfers.ChangedNothing(t.Stats):
			set += `, last_change_at = ?, last_change_id = ?, last_transfer_id = ?`
			args = append(args, at, t.ID, t.ID)
		case !o.Quiet(r, t.State, t.Error, t.Stats):
			set += `, last_transfer_id = ?`
			args = append(args, t.ID)
		}
		if same && r.Data.resync {
			set += `, baselined = 1`
		}
		if same && (r.Mode == modeResync || r.Mode == modeForce || r.Data.resync) {
			set += `, attention = '', deleted_side = ''`
		}
		s.record(ctx, id, set, args...)
		if recovered {
			streak.Up()
		}
	case transfers.StateFailed:
		set, args := `last_run_at = ?, last_result = ?, last_error = ?`, []any{at, ResultFailed, t.SavedError()}
		if t.ID != "" {
			set += `, last_transfer_id = ?`
			args = append(args, t.ID)
		}
		switch {
		case same && r.Data.refilled:
			set += `, attention = ?, deleted_side = ''`
			args = append(args, AttentionResync)
		case same && w.Baselined && !r.Data.resync && !r.Data.sync:
			if attention, side := troubleOf(t.Error); attention != "" {
				set += `, attention = ?, deleted_side = ?`
				args = append(args, attention, side)
			}
		}
		s.record(ctx, id, set, args...)
		streak.Failed(ctx, notifications.WatcherFailed{
			Name: w.Name, PathA: logs.Redact(w.PathA), PathB: logs.Redact(w.PathB), Error: logs.Redact(t.ErrorText().Local()),
		})
	}
	return modeNow, r.Data.sync && t.State == transfers.StateCompleted
}

func (s *Service) record(ctx context.Context, id, set string, args ...any) {
	if err := s.update(ctx, id, set, args...); err != nil && !errors.Is(err, ErrNotFound) {
		s.log.ErrorContext(ctx, "recording a watcher's run", "watcher", id, "error", err)
	}
}

func troubleOf(errText string) (attention, side string) {
	trouble, n := operations.BisyncTroubleOf(errText)
	switch trouble {
	case operations.TroubleResync:
		return AttentionResync, ""
	case operations.TroubleDeletes, operations.TroubleEmptied:
		attention := AttentionDeletes
		if trouble == operations.TroubleEmptied {
			attention = AttentionEmptied
		}
		switch n {
		case 1:
			return attention, SideA
		case 2:
			return attention, SideB
		}
		return attention, ""
	}
	return "", ""
}

var watcherDesktop = notifications.Desktop{Route: "/watchers"}
