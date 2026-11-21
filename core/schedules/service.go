// Package schedules runs operations at set times, for example "Sync ~/Photos to gdrive:Photos
// every day at 02:00". A schedule is an operation's form (Copy, Move, Sync, Bisync, Delete or
// Purge) with a cron expression. The schedules are stored in the app's database. The scheduler
// (scheduler.go) runs inside the app, as the watchers do: it starts each run through the transfer
// service, with the schedule as its origin, and records how it ended. Every change publishes
// schedules.changed.
package schedules

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/runs"
	"github.com/rclone/rclone-ui/core/transfers"
)

// Runner starts, stops and checks transfers. It is *transfers.Service.
type Runner interface {
	runs.Transfers
	// Check builds and checks a transfer as Start does, and records nothing.
	Check(ctx context.Context, f operations.Form) error
	// ToastText returns the desktop notification's title and body for a transfer's end.
	ToastText(ctx context.Context, t transfers.Transfer) (title, body string)
	// FailureText returns a failed transfer's error with its reason.
	FailureText(ctx context.Context, t transfers.Transfer) i18n.Text
}

// Templates gives the form that runs a template as one of its tags (templates.Service).
type Templates interface {
	RunArgs(ctx context.Context, id string, tag operations.Operation) (operations.Form, error)
}

// Watchers tells whether a watcher already keeps two folders the same (watchers.Service).
type Watchers interface {
	Keeps(ctx context.Context, a, b string) (bool, error)
}

type Options struct {
	DB        *db.DB
	Bus       *bus.Bus
	Transfers Runner
	Templates Templates
	Watchers  Watchers
	// Notifier sends job.completed and job.failed to the notification targets, and shows a
	// failure on the desktop.
	Notifier notifications.Notifier
	// Run runs one-shot work (a run's start) on its own goroutine, with a context that ends when
	// the core shuts down. It is the core itself.
	Run syncx.Runner
	// Locked reports whether the config is encrypted and still locked. The runs that catch up
	// after a start wait for it to be unlocked. nil means never locked.
	Locked func() bool
	// Crashed is set when the previous run of the app didn't stop cleanly. Its interrupted runs
	// are then not run again.
	Crashed bool
	// Workdir is bisync's working folder. "" means rclone's own, which the Bisync page uses too.
	Workdir string

	// Now, After and Location are the clock, the timer and the time zone. They default to
	// time.Now, time.After and time.Local, the zone the app started with.
	Now      func() time.Time
	After    func(time.Duration) <-chan time.Time
	Location *time.Location
	// Wait is how long the runs that were missed wait after a start or a wake, so that the network
	// and the drives come up. Spacing separates the starts of runs that are due together. They
	// default to a minute and 10 seconds.
	Wait    time.Duration
	Spacing time.Duration
}

type Service struct {
	o   Options
	log *slog.Logger
	// runs claims, starts and frees the schedules' runs. It holds the run in progress of each
	// schedule, from the moment it is claimed until its end is recorded.
	runs *runs.Engine[mode, runData]

	mu sync.Mutex
	// reruns are the schedules whose last run a quit cut short. Each runs once more after the
	// wait that follows the start.
	reruns   map[string]bool
	stopping bool
	// holdUntil is the end of the wait after a start or a wake, and lastTick the time of the last
	// tick, which tells a wake from a minute.
	holdUntil time.Time
	lastTick  time.Time
}

// New returns a Service. Its scheduler starts with Run.
func New(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.After == nil {
		o.After = time.After
	}
	if o.Location == nil {
		o.Location = time.Local
	}
	if o.Wait <= 0 {
		o.Wait = time.Minute
	}
	if o.Spacing <= 0 {
		o.Spacing = 10 * time.Second
	}
	s := &Service{o: o, log: logs.Logger(logs.CompTransfers, "schedules"), reruns: map[string]bool{}}
	s.runs = runs.New(runs.Options{Name: "schedules", Transfers: o.Transfers, Runner: o.Run, Log: s.log}, (*owner)(s))
	return s
}

var ErrNotFound = errs.NotFound("schedule", "This schedule was deleted.")

// columns are the columns that scan reads.
const columns = `id, name, operation, args, cron, paused, created_at, baselined, last_due, last_run_at,
	last_result, last_error, last_transfer_id, last_skipped_at`

// stored is a schedule as it is stored, with the last time it dealt with.
type stored struct {
	Schedule
	lastDue int64
}

func scan(row db.Scanner) (*stored, error) {
	var (
		s                 stored
		op                operations.Operation
		args              string
		lastRun, lastSkip sql.NullInt64
	)
	var lastError string
	if err := row.Scan(&s.ID, &s.Name, &op, &args, &s.When, &s.Paused, &s.CreatedAt, &s.Baselined,
		&s.lastDue, &lastRun, &s.LastResult, &lastError, &s.LastTransferID, &lastSkip); err != nil {
		return nil, err
	}
	// The last error is saved so that it can be translated (i18n.Save). It is read in English,
	// and the API gives it in the app's language.
	s.lastError = i18n.Saved(lastError)
	s.LastError = s.lastError.String()
	f, err := operations.DecodeForm(op, json.RawMessage(args))
	if err != nil {
		return nil, fmt.Errorf("schedule %s: %w", s.ID, err)
	}
	s.Form = f
	if lastRun.Valid {
		s.LastRunAt = &lastRun.Int64
	}
	if lastSkip.Valid {
		s.LastSkippedAt = &lastSkip.Int64
	}
	return &s, nil
}

func (s *Service) read(ctx context.Context, id string) (*stored, error) {
	var sc *stored
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		var err error
		sc, err = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM schedules WHERE id = ?`, id))
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read schedule %s: %w", id, err)
	}
	return sc, nil
}

func (s *Service) readAll(ctx context.Context) ([]*stored, error) {
	var out []*stored
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM schedules ORDER BY name COLLATE NOCASE, id`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, scan)
		return err
	})
	return out, err
}

// running returns the transfer of each run in progress ("" before its start returns), by
// schedule. It is read before the schedules, so that a run that ends in between shows as running
// with its end, rather than as ended without it.
func (s *Service) running() map[string]string {
	current := s.runs.Current()
	out := make(map[string]string, len(current))
	for id, r := range current {
		out[id] = r.Transfer
	}
	return out
}

// view fills in what isn't stored: the run in progress and the next run.
func (s *Service) view(sc *stored, running map[string]string) *Schedule {
	out := sc.Schedule
	out.RunningID, out.Running = running[sc.ID]
	if !out.Paused {
		if w, err := parseWhen(out.When); err == nil {
			if next := w.next(s.o.Now(), 1, s.o.Location); len(next) > 0 {
				ms := next[0].UnixMilli()
				out.NextRun = &ms
			}
		}
	}
	return &out
}

func (s *Service) Get(ctx context.Context, id string) (*Schedule, error) {
	running := s.running()
	sc, err := s.read(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.view(sc, running), nil
}

// List returns every schedule, sorted by name, each with its next run.
func (s *Service) List(ctx context.Context) ([]*Schedule, error) {
	running := s.running()
	all, err := s.readAll(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*Schedule, len(all))
	for i, sc := range all {
		out[i] = s.view(sc, running)
	}
	return out, nil
}

// Active counts the schedules that aren't paused, which run while the app is open.
func (s *Service) Active(ctx context.Context) (int, error) {
	var n int
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schedules WHERE paused = 0`).Scan(&n)
	})
	return n, err
}

// Describe returns the next 3 times of a cron expression, with the zone's abbreviation, or the
// problem with it in the app's language.
func (s *Service) Describe(expr string) Description {
	now := s.o.Now().In(s.o.Location)
	zone, _ := now.Zone()
	w, err := checkWhen(expr, now, s.o.Location)
	if err != nil {
		return Description{Next: []int64{}, Zone: zone, Problem: i18n.Localize(err)}
	}
	d := Description{Next: []int64{}, Zone: zone}
	for _, t := range w.next(now, 3, s.o.Location) {
		d.Next = append(d.Next, t.UnixMilli())
	}
	return d
}

// FromTemplate returns the form that runs the template id as tag, one of its operations, built as
// StartTemplate builds it.
func (s *Service) FromTemplate(ctx context.Context, id string, tag operations.Operation) (operations.Form, error) {
	if !slices.Contains(Operations, tag) {
		return operations.Form{}, errOperation
	}
	return s.o.Templates.RunArgs(ctx, id, tag)
}

var errOperation = errs.New("A schedule can run a copy, move, sync, bisync, delete or purge.")

// Save creates a schedule (when in.ID is empty) or edits one. It refuses a missing or used name,
// and a cron expression that the app doesn't accept or that never runs, as field errors on name
// and when. When the form is new or changed, it is checked the way Start checks it, which reads
// the sources, and a refusal comes back as one message. A save that only renames a schedule or
// changes its time doesn't check the form again. The form is saved without what is for a single
// run (see clean). A new schedule, or one whose time changed, counts its times from now, so it
// doesn't start a run for a time that has passed. Changing a bisync's folders clears its
// baseline.
func (s *Service) Save(ctx context.Context, in Input) (*Schedule, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.When = strings.TrimSpace(in.When)
	if in.Name == "" {
		return nil, errs.Field("name", "Please enter a name for the schedule")
	}
	if _, err := checkWhen(in.When, s.o.Now(), s.o.Location); err != nil {
		return nil, err
	}
	f := in.Form
	if !slices.Contains(Operations, f.Operation) {
		return nil, errOperation
	}
	if err := f.Check(); err != nil {
		return nil, withoutField(err)
	}
	clean(&f)
	args, err := f.MarshalArgs()
	if err != nil {
		return nil, err
	}

	creating := in.ID == ""
	var old *stored
	if !creating {
		if old, err = s.read(ctx, in.ID); err != nil {
			return nil, err
		}
	}
	formChanged := creating || !sameForm(old.Form, f)
	if err := s.taken(ctx, in.ID, in.Name); err != nil {
		return nil, err
	}
	if formChanged {
		if err := s.o.Transfers.Check(ctx, f); err != nil {
			return nil, refusal(err)
		}
	}

	now := s.o.Now().UnixMilli()
	if creating {
		in.ID = uuid.NewString()
	}
	err = s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		if err := nameFree(ctx, tx, in.ID, in.Name); err != nil {
			return err
		}
		if creating {
			_, err := tx.ExecContext(ctx, `INSERT INTO schedules (id, name, operation, args, cron, created_at, last_due)
				VALUES (?, ?, ?, ?, ?, ?, ?)`, in.ID, in.Name, f.Operation, string(args), in.When, now, now)
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE schedules SET name = ?, operation = ?, args = ?, cron = ?,
			last_due = CASE WHEN cron != ? THEN ? ELSE last_due END,
			baselined = CASE WHEN ? THEN 0 ELSE baselined END
			WHERE id = ?`, in.Name, f.Operation, string(args), in.When, in.When, now,
			movedPaths(old.Form, f), in.ID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		if errs.Is(err) || errors.Is(err, ErrNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("save schedule %s: %w", in.ID, err)
	}
	s.changed()
	out, err := s.Get(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if f.Operation == operations.OperationBisync && s.o.Watchers != nil {
		_, dest := f.Ends()
		if keeps, err := s.o.Watchers.Keeps(ctx, firstSource(f), dest); err == nil && keeps {
			out.Warning = i18n.T("A watcher already keeps these two folders the same.")
		}
	}
	return out, nil
}

// refusal returns a check's error as a single message: only name and when are field errors.
func refusal(err error) error {
	if errs.FieldOf(err) != "" {
		return withoutField(err)
	}
	return err
}

// withoutField returns err as a refusal of the whole form, with the same message, which is still
// translated when the page receives it.
func withoutField(err error) error {
	// Save and Saved give the message as a Text, whether err is the core's own or rclone's.
	return errs.Said(errs.CodeInvalid, i18n.Saved(i18n.Save(err)))
}

// movedPaths reports whether an edit from the form old to f changes the folders of a bisync, or
// makes it one.
func movedPaths(old, f operations.Form) bool {
	if f.Operation != operations.OperationBisync {
		return false
	}
	if old.Operation != operations.OperationBisync {
		return true
	}
	oldSources, oldDest := old.Ends()
	sources, dest := f.Ends()
	return !slices.Equal(oldSources, sources) || oldDest != dest
}

// taken refuses a name that another schedule uses, whatever its case.
func (s *Service) taken(ctx context.Context, id, name string) error {
	return s.o.DB.Read(ctx, func(tx *sql.Tx) error { return nameFree(ctx, tx, id, name) })
}

func nameFree(ctx context.Context, tx *sql.Tx, id, name string) error {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schedules WHERE name = ? COLLATE NOCASE AND id != ?`,
		name, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errs.Field("name", "A schedule called %s exists already.", name)
	}
	return nil
}

// Duplicate copies a schedule as "{name} copy" (then "copy 2" and so on). The copy is paused, so
// that the same job never runs twice at the same time by accident.
func (s *Service) Duplicate(ctx context.Context, id string) (*Schedule, error) {
	sc, err := s.read(ctx, id)
	if err != nil {
		return nil, err
	}
	args, err := sc.Form.MarshalArgs()
	if err != nil {
		return nil, err
	}
	newID := uuid.NewString()
	now := s.o.Now().UnixMilli()
	err = s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		for i := 1; ; i++ {
			// The copy's name is written in the app's language, like any name that the user gives.
			// i18n: The name of a duplicated schedule. "copy" means a duplicate here, not the operation.
			name := i18n.T("%s copy", sc.Name)
			if i > 1 {
				// i18n: The name of a duplicated schedule, when "{name} copy" is taken. "copy" means a duplicate here, not the operation.
				name = i18n.T("%s copy %d", sc.Name, i)
			}
			err := nameFree(ctx, tx, newID, name)
			if errs.FieldOf(err) == "name" {
				continue
			}
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO schedules (id, name, operation, args, cron, paused, created_at, last_due)
				VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, newID, name, sc.Form.Operation, string(args), sc.When, now, now)
			return err
		}
	})
	if err != nil {
		return nil, fmt.Errorf("duplicate schedule %s: %w", id, err)
	}
	s.changed()
	return s.Get(ctx, newID)
}

// Delete removes a schedule. A run in progress goes on and stays in History, and its end changes
// nothing.
func (s *Service) Delete(ctx context.Context, id string) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return fmt.Errorf("remove schedule %s: %w", id, err)
	}
	if n == 0 {
		return ErrNotFound
	}
	s.mu.Lock()
	delete(s.reruns, id)
	s.mu.Unlock()
	s.runs.Forget(ctx, id, false)
	s.changed()
	return nil
}

// Pause stops a schedule's future runs. A run in progress goes on.
func (s *Service) Pause(ctx context.Context, id string) error {
	if err := s.update(ctx, id, `paused = 1`); err != nil {
		return err
	}
	s.changed()
	return nil
}

// Resume runs a paused schedule again, counting its times from now, so the times it missed while
// paused don't start a run.
func (s *Service) Resume(ctx context.Context, id string) error {
	if err := s.update(ctx, id, `paused = 0, last_due = ?`, s.o.Now().UnixMilli()); err != nil {
		return err
	}
	s.changed()
	return nil
}

// update sets columns of the schedule id. It returns ErrNotFound when there is none.
func (s *Service) update(ctx context.Context, id, set string, args ...any) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE schedules SET `+set+` WHERE id = ?`, append(args, id)...)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return fmt.Errorf("update schedule %s: %w", id, err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// RunNow runs a schedule at once, paused or not. It doesn't change when the schedule runs next.
func (s *Service) RunNow(ctx context.Context, id string) error {
	sc, err := s.read(ctx, id)
	if err != nil {
		return err
	}
	if !s.kick(id, modeNow) {
		return errs.Errorf("%s is running already.", sc.Name)
	}
	return nil
}

// MergeAgain runs one merge of a bisync's two folders, newer wins, which deletes nothing. If it
// succeeds, the schedule is baselined, and its runs go on from the merge.
func (s *Service) MergeAgain(ctx context.Context, id string) error {
	sc, err := s.read(ctx, id)
	if err != nil {
		return err
	}
	if sc.Form.Operation != operations.OperationBisync {
		return errs.New("Only a bisync's folders can be merged.")
	}
	if !s.kick(id, modeMerge) {
		return errs.Errorf("%s is running already.", sc.Name)
	}
	return nil
}

func (s *Service) changed() { s.o.Bus.Publish(bus.SchedulesChanged, nil) }
