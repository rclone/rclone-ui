package schedules

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"time"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/runs"
	"github.com/rclone/rclone-ui/core/transfers"
)

type mode int

const (
	modeDue mode = iota
	modeNow
	modeMerge
)

type run = runs.Run[mode, runData]

type runData struct {
	name      string
	form      operations.Form
	bisync    bool
	a, b      string
	baselined bool
}

func (s *Service) Run(ctx context.Context) {
	s.boot(ctx)
	for {
		s.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-s.o.After(s.untilNext()):
		}
	}
}

func (s *Service) untilNext() time.Duration {
	now := s.o.Now()
	next := now.Truncate(time.Minute).Add(time.Minute + 500*time.Millisecond)
	s.mu.Lock()
	if hold := s.holdUntil.Add(100 * time.Millisecond); hold.After(now) && hold.Before(next) {
		next = hold
	}
	s.mu.Unlock()
	return next.Sub(now)
}

func (s *Service) boot(ctx context.Context) {
	now := s.o.Now()
	s.mu.Lock()
	s.holdUntil, s.lastTick = now.Add(s.o.Wait), now
	s.mu.Unlock()
	var again []string
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		type open struct{ id, transfer string }
		rows, err := tx.QueryContext(ctx, `SELECT id, running_id FROM schedules WHERE running_id != ''`)
		if err != nil {
			return err
		}
		all, err := db.Collect(rows, func(sc db.Scanner) (open, error) {
			var o open
			return o, sc.Scan(&o.id, &o.transfer)
		})
		if err != nil {
			return err
		}
		for _, o := range all {
			result, errText, transfer, at := s.endOf(ctx, tx, o.transfer, now)
			if _, err := tx.ExecContext(ctx, `UPDATE schedules SET running_id = '', last_result = ?,
				last_error = ?, last_transfer_id = ?, last_run_at = ?, resume = ? WHERE id = ?`,
				result, errText, transfer, at, result == ResultInterrupted, o.id); err != nil {
				return err
			}
		}
		if !s.o.Crashed {
			rows, err := tx.QueryContext(ctx, `SELECT id FROM schedules WHERE resume = 1 AND paused = 0`)
			if err != nil {
				return err
			}
			if again, err = db.Collect(rows, func(sc db.Scanner) (string, error) {
				var id string
				return id, sc.Scan(&id)
			}); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE schedules SET resume = 0 WHERE resume = 1`)
		return err
	})
	if err != nil {
		s.log.ErrorContext(ctx, "settling the schedules' last runs", "error", err)
		return
	}
	s.mu.Lock()
	for _, id := range again {
		s.reruns[id] = true
	}
	s.mu.Unlock()
}

func (s *Service) endOf(ctx context.Context, tx *sql.Tx, id string, now time.Time) (result, errText, transfer string, at int64) {
	var (
		state string
		ended sql.NullInt64
		text  sql.NullString
	)
	err := tx.QueryRowContext(ctx, `SELECT state, ended_ms, error FROM transfers WHERE id = ?`, id).
		Scan(&state, &ended, &text)
	at = now.UnixMilli()
	if ended.Valid {
		at = ended.Int64
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ResultNothing, "", "", at
	case err != nil:
		return ResultInterrupted, "", id, at
	}
	switch transfers.State(state) {
	case transfers.StateCompleted:
		return ResultCompleted, "", id, at
	case transfers.StateFailed:
		return ResultFailed, text.String, id, at
	case transfers.StateStopped:
		return ResultStopped, "", id, at
	}
	return ResultInterrupted, "", id, at
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	s.stopping = true
	s.mu.Unlock()
	s.runs.Shutdown()
}

type claimed struct {
	id string
	r  *run
}

func (s *Service) tick(ctx context.Context) {
	now := s.o.Now()
	s.mu.Lock()
	if now.Sub(s.lastTick) > 2*time.Minute || now.Before(s.lastTick) {
		s.holdUntil = now.Add(s.o.Wait)
	}
	s.lastTick = now
	holding := now.Before(s.holdUntil) || s.stopping
	s.mu.Unlock()
	if !holding && s.o.Locked != nil && s.o.Locked() {
		holding = true
	}
	s.runs.FreeStale(ctx)

	all, err := s.readAll(ctx)
	if err != nil {
		if ctx.Err() == nil {
			s.log.ErrorContext(ctx, "reading the schedules", "error", err)
		}
		return
	}
	var (
		starts  []claimed
		changed bool
	)
	for _, sc := range all {
		if sc.lastDue > now.UnixMilli() {
			s.record(ctx, sc.ID, `last_due = ?`, now.UnixMilli())
			continue
		}
		w, err := parseWhen(sc.When)
		if err != nil {
			continue
		}
		at := w.latest(time.UnixMilli(sc.lastDue), now, s.o.Location)
		s.mu.Lock()
		rerun := s.reruns[sc.ID]
		if sc.Paused {
			delete(s.reruns, sc.ID)
		}
		s.mu.Unlock()
		if sc.Paused || at.IsZero() && !rerun || holding {
			continue
		}
		s.mu.Lock()
		delete(s.reruns, sc.ID)
		s.mu.Unlock()
		r, free := s.runs.Claim(sc.ID, modeDue)
		switch {
		case !free && !at.IsZero():
			s.log.InfoContext(ctx, "skipping a scheduled time: the last run is still going", "schedule", sc.ID, "at", at)
			s.record(ctx, sc.ID, `last_due = ?, last_skipped_at = ?`, at.UnixMilli(), at.UnixMilli())
			changed = true
		case free:
			if !at.IsZero() {
				s.record(ctx, sc.ID, `last_due = ?`, at.UnixMilli())
			}
			starts = append(starts, claimed{sc.ID, r})
			changed = true
		}
	}
	if changed {
		s.changed()
	}
	if len(starts) == 0 {
		return
	}
	s.o.Run.GoOnce("schedules.start", func(ctx context.Context) {
		for i, c := range starts {
			if i > 0 {
				select {
				case <-ctx.Done():
				case <-s.o.After(s.o.Spacing):
				}
			}
			s.runs.Start(ctx, c.id, c.r)
		}
	})
}

func (s *Service) kick(id string, m mode) bool {
	if !s.runs.Kick(id, m) {
		return false
	}
	s.changed()
	return true
}

type owner Service

func (o *owner) Start(ctx context.Context, id string, r *run, end transfers.Owner) (transfers.Started, bool, error) {
	s := (*Service)(o)
	sc, err := s.read(ctx, id)
	switch {
	case err != nil:
		if !errors.Is(err, ErrNotFound) {
			s.log.ErrorContext(ctx, "reading a schedule to run", "schedule", id, "error", err)
		}
		return transfers.Started{}, false, nil
	case r.Mode == modeDue && sc.Paused:
		return transfers.Started{}, false, nil
	}
	f, preset := sc.Form, sc.Form
	r.Data = runData{name: sc.Name}
	if f.Operation == operations.OperationBisync {
		r.Data.bisync, r.Data.a, r.Data.baselined = true, firstSource(f), sc.Baselined
		_, r.Data.b = f.Ends()
		f = unattended(f, r.Mode == modeMerge, s.o.Workdir)
	}
	origin := transfers.Origin{Kind: transfers.OriginSchedule, ID: sc.ID, Name: sc.Name}
	for {
		r.Data.form = f
		started, err := s.o.Transfers.Start(ctx, transfers.Spec{Form: f, Origin: origin, Preset: &preset, Owner: end})
		var missing *operations.SourceMissingError
		if err != nil && started.ID == "" && dropsMissing(f.Operation) && errors.As(err, &missing) {
			var left int
			if f, left = withoutSource(f, missing.Path); left > 0 {
				continue
			}
			s.log.InfoContext(ctx, "a scheduled run had nothing to do: its sources are gone", "schedule", id)
			s.record(ctx, id, `last_run_at = ?, last_result = ?, last_error = '', last_transfer_id = '',
				last_skipped_at = NULL`, s.o.Now().UnixMilli(), ResultNothing)
			return transfers.Started{}, false, nil
		}
		return started, true, err
	}
}

func (o *owner) Started(ctx context.Context, id string, _ *run, transfer string) {
	s := (*Service)(o)
	s.record(ctx, id, `running_id = ?, last_skipped_at = NULL`, transfer)
	s.changed()
}

func (o *owner) Changed() { (*Service)(o).changed() }

func (o *owner) Quiet(r *run, st transfers.State, errText string, s *transfers.Summary) bool {
	if st == transfers.StateCompleted && transfers.ChangedNothing(s) {
		return true
	}
	return r.Data.bisync && r.Mode != modeMerge && quietBisync(st, errText, s, r.Data.baselined)
}

func quietBisync(state transfers.State, errText string, summary *transfers.Summary, baselined bool) bool {
	if state != transfers.StateFailed || !transfers.ChangedNothing(summary) {
		return false
	}
	trouble, _ := operations.BisyncTroubleOf(errText)
	return trouble == operations.TroubleMerge || !baselined && trouble == operations.TroubleResync
}

func (o *owner) Refused(ctx context.Context, id string, r *run, cause error) {
	s := (*Service)(o)
	s.log.WarnContext(ctx, "a scheduled run was refused", "schedule", id, "error", cause)
	t := transfers.Transfer{State: transfers.StateFailed, Operation: r.Data.form.Operation}.WithError(cause)
	t.Sources, t.Destination = r.Data.form.Ends()
	s.record(ctx, id, `last_run_at = ?, last_result = ?, last_error = ?, last_transfer_id = '',
		last_skipped_at = NULL`, s.o.Now().UnixMilli(), ResultFailed, i18n.Save(cause))
	s.failed(ctx, r.Data.name, t)
}

func (o *owner) Ended(ctx context.Context, id string, r *run, t transfers.Transfer) (mode, bool) {
	s := (*Service)(o)
	sc, err := s.read(ctx, id)
	if err != nil {
		return 0, false
	}
	at := s.o.Now().UnixMilli()
	if t.EndedAt != nil {
		at = *t.EndedAt
	}
	const clear = `, running_id = CASE WHEN running_id = ? THEN '' ELSE running_id END`
	bisync := sc.Form.Operation == operations.OperationBisync
	_, dest := sc.Form.Ends()
	same := bisync && firstSource(sc.Form) == r.Data.a && dest == r.Data.b
	switch t.State {
	case transfers.StateCompleted:
		result, transfer := ResultCompleted, t.ID
		if transfers.ChangedNothing(t.Stats) {
			result, transfer = ResultNothing, ""
		}
		set := `last_run_at = ?, last_result = ?, last_error = '', last_transfer_id = ?`
		if same && r.Mode == modeMerge {
			set += `, baselined = 1`
		}
		s.record(ctx, id, set+clear, at, result, transfer, t.ID)
		if result == ResultCompleted {
			s.o.Notifier.Notify(ctx, notifications.NotificationEventJobCompleted, jobOf(sc.Name, t))
		}
	case transfers.StateFailed:
		if bisync && r.Mode != modeMerge && quietBisync(t.State, t.Error, t.Stats, r.Data.baselined) {
			s.record(ctx, id, clear[2:], t.ID)
			if same {
				s.log.InfoContext(ctx, "merging a scheduled bisync's folders", "schedule", id)
			}
			return modeMerge, same
		}
		errText := s.o.Transfers.FailureText(ctx, t)
		if bisync {
			errText = bisyncError(t.ErrorText(), r.Data.a, r.Data.b)
		}
		t = t.WithErrorText(errText)
		s.record(ctx, id, `last_run_at = ?, last_result = ?, last_error = ?, last_transfer_id = ?`+clear,
			at, ResultFailed, t.SavedError(), t.ID, t.ID)
		s.failed(ctx, sc.Name, t)
	case transfers.StateStopped:
		s.record(ctx, id, `last_run_at = ?, last_result = ?, last_error = '', last_transfer_id = ?`+clear,
			at, ResultStopped, t.ID, t.ID)
	case transfers.StateInterrupted:
		s.record(ctx, id, `last_run_at = ?, last_result = ?, last_error = '', last_transfer_id = ?, resume = 1`+clear,
			at, ResultInterrupted, t.ID, t.ID)
	}
	return 0, false
}

func bisyncError(errText i18n.Text, a, b string) i18n.Text {
	trouble, side := operations.BisyncTroubleOf(errText.String())
	var folder any
	switch side {
	case 1:
		folder = a
	case 2:
		folder = b
	default:
		// i18n: Stands for the folder that lost its files, when bisync didn't say which, as in "Many files were deleted in one of the folders".
		folder = i18n.M("one of the folders")
	}
	switch trouble {
	case operations.TroubleResync:
		return i18n.M("Bisync needs a merge. Choose Merge again in the schedule's menu.")
	case operations.TroubleDeletes:
		// i18n: A scheduled bisync's error. The value is a folder.
		return i18n.M("Many files were deleted in %s, so the bisync stopped. If that was meant, run the "+
			"Bisync page once with Force. To bring them back, choose Merge again.", folder)
	case operations.TroubleEmptied:
		// i18n: A scheduled bisync's error. The value is a folder.
		return i18n.M("Every file in %s is gone, so the bisync stopped. If the folder is on a drive, check "+
			"that it is connected. To bring the files back, choose Merge again.", folder)
	}
	return errText
}

func (s *Service) failed(ctx context.Context, name string, t transfers.Transfer) {
	job := jobOf(name, t)
	s.o.Notifier.Notify(ctx, notifications.NotificationEventJobFailed, job)
	_, body := s.o.Transfers.ToastText(ctx, t)
	route := "/schedules"
	if t.ID != "" {
		route = "/history?id=" + url.QueryEscape(t.ID)
	}
	s.o.Notifier.Desktop(ctx, notifications.NotificationEventJobFailed, job, notifications.Desktop{
		// i18n: The title of the notification for a schedule's failed run. The value is the schedule's name.
		Title: i18n.T("%s failed", name), Body: body, Route: route, ToastOnly: true,
	})
}

func jobOf(name string, t transfers.Transfer) notifications.Job {
	j := notifications.Job{JobID: t.Seq, Operation: string(t.Operation), Sources: t.Sources, Destination: t.Destination,
		Error: t.ErrorText().Local(), Schedule: name}
	if t.Stats != nil {
		d := t.Stats.DurationMs / 1000
		j.DurationSeconds = &d
	} else if t.State == transfers.StateFailed {
		var zero int64
		j.DurationSeconds = &zero
	}
	return j
}

func (s *Service) record(ctx context.Context, id, set string, args ...any) {
	if err := s.update(ctx, id, set, args...); err != nil && !errors.Is(err, ErrNotFound) {
		s.log.ErrorContext(ctx, "recording a schedule's run", "schedule", id, "error", err)
	}
}
