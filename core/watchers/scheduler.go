package watchers

import (
	"context"
	"errors"
	"time"

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

// mode is why a run starts.
type mode int

const (
	// modeNormal is the minute's run, or a run after a change. It is skipped while the watcher
	// is paused or needs the user.
	modeNormal mode = iota
	// modeNow is "Sync now", which runs even while the watcher is paused.
	modeNow
	// modeResync is one newer-wins merge, which runs even while the watcher needs the user.
	modeResync
	// modeForce runs with bisync's force, after its max-delete safety stopped the watcher.
	modeForce
)

// maxDelete is the share of a folder's files, in percent, that a run may delete. Past it,
// bisync stops and the watcher needs the user.
const maxDelete = 50

// state is what the scheduler holds for one watcher, besides its run (see runs.Engine).
type state struct {
	// streak sends watcher.failed once per streak of failures, and failing is set while the
	// last run failed.
	streak  *notifications.Streak
	failing bool
	// merge makes the next run a merge. It is set when bisync found a side that the last run
	// left empty, and after a force that emptied the other folder. Unlike a Resync, it isn't
	// shown: the watcher stays as it was.
	merge bool
}

type run = runs.Run[mode, runData]

// runData is what the scheduler keeps about a run, from its start.
type runData struct {
	// a and b are the folders that the run syncs, and resync is set when it merges them.
	a, b   string
	resync bool
	// sync is set for a force after every file of a folder was deleted. It is a one-way sync
	// from the empty folder to the other one.
	sync bool
	// refilled is set for such a force that didn't start, because the empty folder had files
	// again (errRefilled).
	refilled bool
}

// stateOf returns the state of the watcher id, creating it. The caller holds s.mu.
func (s *Service) stateOf(id string) *state {
	st := s.states[id]
	if st == nil {
		st = &state{streak: notifications.NewStreak(s.o.Notifier, notifications.NotificationEventWatcherFailed, &watcherDesktop)}
		s.states[id] = st
	}
	return st
}

// Run is the scheduler. It runs every watcher at once, and then every Tick, until ctx ends. A
// watcher that is paused, needs the user, or has a run in progress is skipped.
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

// tick starts a run of each watcher that is due. First it frees the runs whose transfer has
// ended without telling the watcher (runs.Engine.FreeStale).
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

// Shutdown stops the scheduler from starting runs. The runs in progress are the transfer
// service's, which stops them.
func (s *Service) Shutdown() { s.runs.Shutdown() }

// kick starts a run of the watcher id unless one is in progress, so the runs of a watcher never
// overlap. A resync or a force asked for while a run is in progress starts once it ends.
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
		s.changed() // the watcher shows it is initializing
	}
}

// resyncing reports whether a resync of the watcher id was asked for and hasn't ended: it waits
// for the run in progress, or it is that run. current is the engine's runs.
func resyncing(current map[string]runs.Status[mode], id string) bool {
	st, ok := current[id]
	return ok && (st.Mode == modeResync || st.Queued && st.Next == modeResync)
}

// bisyncParams returns the switches of a run's bisync, which runs unattended
// (operations.UnattendedBisync). Both versions of a file changed on both sides are kept: the newer
// one wins, and the other is renamed with a number. A run that merges the folders keeps the newer
// file and deletes nothing. maxDelete is bisync's command-line default.
func (s *Service) bisyncParams(r *run) operations.BisyncSwitches {
	most := maxDelete
	p := operations.UnattendedBisync(operations.BisyncSwitches{
		MaxDelete: &most, ConflictResolve: "newer", ConflictLoser: "num", CreateEmptySrcDirs: true,
	}, r.Data.resync, s.o.Workdir)
	p.Force = r.Mode == modeForce
	return p
}

// owner is the watchers' side of the run engine (runs.Owner).
type owner Service

// Start starts r, a run of the watcher id, as a bisync transfer. It goes through the Bisync
// page's form (operations.BisyncArgs), so it is built and checked the same way. A run that its
// mode doesn't allow any more, such as the minute's run of a watcher paused meanwhile, doesn't
// start.
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

// Started does nothing: a watcher doesn't show its run in progress.
func (o *owner) Started(context.Context, string, *run, string) {}

// Refused records a run that was refused before anything was recorded, such as a folder on a
// remote that doesn't exist. It fails like a run that started.
func (o *owner) Refused(ctx context.Context, id string, r *run, err error) {
	now := time.Now().UnixMilli()
	o.Ended(ctx, id, r, transfers.Transfer{State: transfers.StateFailed, EndedAt: &now}.WithError(err))
}

func (o *owner) Changed() { (*Service)(o).changed() }

// runArgs returns the form of a run: a bisync, through the Bisync page's form
// (operations.BisyncArgs) so that it is built and checked the same way. A force after every file
// of a folder was deleted is a sync from that empty folder to the other one instead, through the
// Sync page's form.
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

// errRefilled is the end of a force that didn't start, because the folder that lost every file
// has files again: a sync from it would delete the other folder's files that it lacks, and
// replace newer versions with older ones. The watcher then needs a resync instead.
var errRefilled = errs.New("The folder that was empty has files again, so nothing was deleted. Resync merges the two folders and deletes nothing.")

// stillEmpty checks, before a force syncs from the folder that lost every file, that the folder
// still has no file. It returns errRefilled when it has one. It returns another error when the
// folder can't be listed, such as a disk that isn't attached, and the watcher then stays as it is.
// Force checks too, so that the page can say why nothing happened.
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

// hasFiles reports whether the folder at path holds a file, at any depth. It stops at the first
// one. A folder that doesn't exist is an error, because a sync from it would fail anyway.
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

// errFoundFile stops hasFiles's listing at the first file.
var errFoundFile = errors.New("watchers: a file was found")

// Quiet reports whether a run that ended so leaves no trace in History: bisync only asked for a
// merge, which the watcher runs at once (see mergeAsked), or the run changed nothing. A Resync or
// a Force that the user asked for is always kept, as are a stop and an interruption.
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

// mergeAsked reports whether a failed run only stopped because the last run left a side empty,
// which a merge fixes. A run that merged already, or a force, can't be helped by one.
func mergeAsked(r *run, errText string) bool {
	trouble, _ := operations.BisyncTroubleOf(errText)
	return trouble == operations.TroubleMerge && !r.Data.resync && r.Mode != modeForce
}

// Ended records how r, a run of the watcher id, ended, from its transfer t. A run that copied,
// deleted or renamed a file is the watcher's last change. A run that merged the folders
// baselines the watcher, and a resync or a force that succeeded clears what the watcher needed.
// When the run failed because bisync can't go on by itself, the watcher needs the user. What a
// run finds is only recorded while the watcher still has the run's folders. A stopped or
// interrupted run changes nothing. A resync or a force asked for during the run starts after it
// (runs.Engine).
//
// A run that bisync stopped because the last run left a side empty is quiet: nothing is recorded
// and nobody is told, and a merge runs at once. So does the merge after a force that emptied the
// other folder.
func (o *owner) Ended(ctx context.Context, id string, r *run, t transfers.Transfer) (mode, bool) {
	s := (*Service)(o)
	s.mu.Lock()
	st := s.states[id]
	if st == nil { // deleted
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
			st.merge = true // the merge that sets the baseline, below
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
			// A Resync or a Force that changed nothing is still kept in History.
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
		// The error is saved so that the page shows it in the app's language of the day.
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

// record writes a run's end on the watcher id.
func (s *Service) record(ctx context.Context, id, set string, args ...any) {
	if err := s.update(ctx, id, set, args...); err != nil && !errors.Is(err, ErrNotFound) {
		s.log.ErrorContext(ctx, "recording a watcher's run", "watcher", id, "error", err)
	}
}

// troubleOf returns what a failed run's error says the watcher needs from the user, and for
// too many deletes, which folder lost the files. Both are "" for a failure that the next run may
// fix.
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

// watcherDesktop shows a watcher's failure on the desktop too. A click on the notification opens
// the Watchers window.
var watcherDesktop = notifications.Desktop{Route: "/watchers"}
