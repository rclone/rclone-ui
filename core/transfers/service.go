// Package transfers keeps the transfer record and runs the service that writes it. The service
// starts every transfer (from an operation page, the Commander, a retry or a resume) as one rclone
// job that runs its plan (operations.Plan) in its own stats group. It watches the job through the
// group's *accounting.StatsInfo, records the transfer's files every second and its end once,
// reports what happened (events, notifications and the end callback), and serves the pages' reads.
// A transfer can have an owner (Owner), such as a watcher or a schedule, which hears its end and
// tells the user about it itself.
//
// A transfer ends only once. Its end is written by a single conditional UPDATE when its job
// finishes. A stop, a shutdown or the recovery at the next start can claim the transfer first (as
// stopped or interrupted), and the end then keeps that state. The one exception is a stop that
// reached a job whose plan had already returned on its own.
package transfers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc/jobs"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

const (
	// launchGrace is how long Start waits for a new transfer to fail before it returns. A wrong
	// path or a refused login ends a job within moments, and the page wants to show that as an
	// error on its form.
	launchGrace = time.Second
	// maxCompleted is how many finished files a transfer's stats group keeps between two ticks.
	// rclone's default is 100, which a fast copy of small files can exceed in one second. It is
	// not unlimited (-1), because that would keep every file in memory and copy them all on each
	// tick. Missing a few is acceptable: a sync's failures also come from rclone's logger, and
	// Retry re-runs a folder when not all of its failures were seen.
	//
	// rclone's bisync lifts the cap of its stats group for each of its copies, so that its
	// graceful shutdown on an exit signal has every file (cmd/bisync/queue.go). The app turns
	// rclone's signal handling off (core.Start), so that shutdown never runs here, and each tick
	// puts the cap back (capCompleted).
	maxCompleted = 2000
	// keepEnded is how many ended transfers the ledger keeps.
	keepEnded = 500
	// shutdownWait limits how long Shutdown waits for the end handlers.
	shutdownWait = 5 * time.Second
)

// endRetries are the waits between attempts to write a transfer's end (see retryEnd). A write
// can fail when the database stays busy past its timeout, or when the disk is full. Together they
// give a full disk about a minute to have room again. During a shutdown, retryEnd stops waiting,
// so that the end is written on its own before the app quits.
var endRetries = []time.Duration{
	time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second,
}

var (
	// ErrShuttingDown is returned by a start while the app is stopping. Nothing was recorded.
	ErrShuttingDown = errs.Unavailable(errs.New("the app is shutting down"))
	ErrNotFound     = errs.NotFound("transfer", "No such transfer")
	ErrNotRunning   = errs.New("This transfer is not running")
	ErrNotEnded     = errs.New("Only the failed items of a transfer that has ended can be retried")
	ErrNoRetry      = errs.New("Nothing to retry")
)

type Options struct {
	DB       *db.DB
	Bus      *bus.Bus
	Notifier notifications.Notifier
	// Run runs the service's background work for the lifetime of the core (the core itself).
	// Required.
	Run syncx.Runner
	Now func() time.Time // default time.Now
	// Executable is the path of the app's binary, which the app's own metadata mapper runs.
	// "" means os.Executable().
	Executable string
	// Ended is called with each transfer once its end is written, such as to drop the listings it
	// changed (browse.Lister.TransferEnded). It runs on the end handler and must not block. nil
	// means nothing is called.
	Ended func(Transfer)
}

// Service is the transfer service. There is one per process.
type Service struct {
	db       *db.DB
	bus      *bus.Bus
	notifier notifications.Notifier
	run      syncx.Runner
	now      func() time.Time
	exe      string
	log      *slog.Logger

	// interrupted is the number of open transfers that Recover found and marked interrupted.
	interrupted atomic.Int64

	// startMu keeps Shutdown from missing a transfer that is starting. Start holds it for reading
	// from the moment its plan is built until its job is watched. Shutdown holds it for writing,
	// so once Shutdown has it, every started job is in running. Start builds the plan before
	// taking the lock, because building it may call the remotes, and Shutdown shouldn't wait for
	// that.
	startMu sync.RWMutex
	// stopping is set by Shutdown while it holds startMu. Start first reads it without the lock,
	// so a start during a shutdown is refused at once instead of waiting for the lock.
	stopping atomic.Bool

	// endWaits are the waits between attempts to write an end (endRetries). Tests shorten them.
	endWaits []time.Duration
	// shutdown is closed when Shutdown begins, which cuts the waits of retryEnd short.
	shutdown     chan struct{}
	shutdownOnce sync.Once

	mu      sync.Mutex
	running map[string]*running
	ticking bool
	onEnded func(Transfer)
	// owners holds the owner of each owned transfer, by id, until its end is reported.
	owners map[string]Owner

	// ends counts the end handlers that have not finished. Shutdown waits for them.
	ends sync.WaitGroup

	// snapshotted runs in a tick after it has read the transfers' numbers (for tests).
	snapshotted func()
	// inserted runs in Start after the row is inserted and before the job starts (for tests).
	inserted func(id string)
	// reported runs once an end has been reported in full, notifications included (for tests).
	reported func(id string)
}

// running is a transfer whose job has started and not ended.
type running struct {
	id, group string
	seq       int64
	operation operations.Operation
	dryRun    bool
	plan      operations.Plan
	rec       *operations.Record // what the plan has done so far, step by step
	stats     *accounting.StatsInfo
	job       *jobs.Job
	// ranOut is set when the plan returned before anything cancelled its job (see ranOutAlone).
	ranOut *atomic.Bool
	// owner is the transfer's owner, or nil.
	owner Owner
	// watcher is set for a watcher's own run, which the tray's count leaves out. A retry of one
	// is the user's own run.
	watcher bool

	// ended is closed once the end is written. launchErr is set before that.
	ended     chan struct{}
	launchErr string
	// launched is closed when Start's launch check is done, so the end is reported after
	// "started".
	launched chan struct{}
	// quiet is set before launched is closed, for an end that the desktop is not told about.
	// That is the end of a rename or a folder delete (the Commander shows those where they were
	// started), or a failure that Start returned (the page shows it).
	quiet bool

	prev map[fileKey]int64     // used by the ticker: the finished files seen on the last tick
	live *bus.TransferProgress // the numbers from the last tick; guarded by s.mu
}

type fileKey struct{ srcFs, name, what string }

// Owner is what started a transfer and hears its end, such as a watcher or a schedule
// (core/runs). An owned transfer sends no job.started, and nobody is told about its end: the
// owner tells the user itself. A retry never has an owner, because it is the user's own run.
type Owner interface {
	// Quiet reports whether a transfer that ended so did nothing worth keeping. Its row is then
	// dropped instead of ended, and the pages are told it is gone (StateDropped).
	Quiet(state State, errText string, s *Summary) bool
	// Ended is called with the transfer once its end is written, after Options.Ended. It may be
	// called before Start returns, when the transfer fails at once. It runs on the end handler,
	// so it must not block.
	Ended(t Transfer)
}

// ranOutAlone reports whether the plan returned on its own, before anything cancelled its job. A
// stop that reaches the job after that doesn't make the transfer stopped.
func (rn *running) ranOutAlone() bool { return rn.ranOut != nil && rn.ranOut.Load() }

func New(o Options) *Service {
	s := &Service{
		db: o.DB, bus: o.Bus, notifier: o.Notifier, run: o.Run, now: o.Now, exe: o.Executable, onEnded: o.Ended,
		log:      logs.Logger(logs.CompTransfers, ""),
		running:  map[string]*running{},
		owners:   map[string]Owner{},
		endWaits: endRetries,
		shutdown: make(chan struct{}),
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.exe == "" {
		s.exe, _ = os.Executable()
	}
	return s
}

// Spec is one transfer to start.
type Spec struct {
	// Form is the form of an operation that BuildPlan accepts (copy, …, save, rename,
	// delete-folder). With a prebuilt Plan, only its Operation is set, and it is the recorded
	// operation.
	Form operations.Form
	// Plan is a prebuilt plan, for a retry or a resume.
	Plan *operations.Plan
	// Sources and Destination are shown on the row. When Sources is nil and the plan is built
	// from the form, both come from the form.
	Sources     []string
	Destination string
	DryRun      bool
	// Origin is where the transfer was started from. Start refuses a transfer without one. A
	// retry gets its original's origin instead.
	Origin Origin
	// Preset is the form that Duplicate reopens the page with.
	Preset *operations.Form
	// RetryOf is the transfer that this one retries. The retry inherits its args, preset, origin
	// and dry run setting, but it is the user's own run, so it never has an owner.
	RetryOf string
	// Owner hears the transfer's end, and tells the user about it instead of the service. It is
	// ignored for a retry.
	Owner Owner
}

// Started identifies the transfer that a Start recorded.
type Started struct {
	ID  string `json:"id"`
	Seq int64  `json:"seq"`
}

// row is a transfer about to be inserted.
type row struct {
	id, destination string
	operation       operations.Operation
	sources         []string
	dryRun          bool
	args, preset    json.RawMessage
	plan            operations.Plan
	retryOf         string
	origin          Origin
}

// Start records a transfer and starts its plan as a job. When an error happens before the row
// exists, nothing is recorded and Started is zero. When it happens later (the job could not
// start, its start could not be recorded, or it failed within the launch check), Started
// identifies the failed transfer.
func (s *Service) Start(ctx context.Context, r Spec) (Started, error) {
	if s.stopping.Load() {
		return Started{}, ErrShuttingDown
	}
	if o, ok := ctx.Value(originKey{}).(Origin); ok && (r.Origin.Kind == OriginPage || r.Origin.Kind == OriginCommander) {
		r.Origin = o
	}
	if r.RetryOf == "" && !r.Origin.Kind.valid() {
		return Started{}, fmt.Errorf("unknown origin %q", r.Origin.Kind)
	}
	// The plan is built before taking startMu (see startMu). Building it can stall, for
	// example on a stat of a stalled mount.
	rw, err := s.prepare(ctx, r)
	if err != nil {
		return Started{}, err
	}
	s.startMu.RLock()
	held := true
	release := func() {
		if held {
			held = false
			s.startMu.RUnlock()
		}
	}
	defer release()
	// If a shutdown began while the plan was being built, record nothing.
	if s.stopping.Load() {
		return Started{}, ErrShuttingDown
	}
	rw.id = newID(s.now())
	seq, err := s.insert(ctx, rw)
	if err != nil {
		return Started{}, fmt.Errorf("recording the transfer: %w", err)
	}
	owner := r.Owner
	if r.RetryOf != "" {
		owner = nil
	}
	if owner != nil {
		s.mu.Lock()
		s.owners[rw.id] = owner
		s.mu.Unlock()
	}
	if s.inserted != nil {
		s.inserted(rw.id)
	}
	started := Started{ID: rw.id, Seq: seq}
	group := groupOf(rw.id)
	// From here on the transfer exists, so the work that records it must not stop when the
	// caller's request is cancelled.
	asked := ctx
	ctx = logs.With(context.WithoutCancel(ctx), logs.Transfer(rw.id), logs.StatsGroup(group),
		logs.Operation(string(rw.operation)))

	// Get the group before the job starts, and use only this handle afterwards. Looking the
	// group up by name after it was deleted would create it again.
	stats := accounting.StatsGroup(ctx, group)
	stats.SetMaxCompletedTransfers(maxCompleted)

	plan, rec := rw.plan, operations.NewRecord(rw.plan)
	startedMS := s.now().UnixMilli()
	ranOut := new(atomic.Bool)
	job, err := rclone.Run(ctx, rclone.CallOpts{Group: group, Async: true}, func(ctx context.Context) error {
		err := plan.Run(ctx, s.exe, rec)
		ranOut.Store(ctx.Err() == nil)
		return err
	})
	if err != nil {
		release()
		s.refused(ctx, rw, seq, err)
		return started, err
	}
	rn := &running{
		id: rw.id, group: group, seq: seq, operation: rw.operation, dryRun: rw.dryRun,
		plan: plan, rec: rec, stats: stats, job: job, ranOut: ranOut,
		owner: owner, watcher: owner != nil && rw.origin.Kind == OriginWatcher,
		ended: make(chan struct{}), launched: make(chan struct{}),
		quiet: r.Form.Operation == operations.OperationRename || r.Form.Operation == operations.OperationDeleteFolder,
		prev:  map[fileKey]int64{},
	}
	defer close(rn.launched)
	s.mu.Lock()
	s.running[rw.id] = rn
	s.startTicker()
	s.mu.Unlock()
	s.ends.Add(1)
	job.OnFinish(func() { s.finish(rn) })
	release()

	state, err := s.markRunning(ctx, rw.id, startedMS)
	if err != nil {
		// The state can't be read, so we can't tell whether a stop claimed the transfer
		// meanwhile. Stop the job so that it doesn't run without its start being recorded. Its
		// end handler still writes its end.
		s.log.ErrorContext(ctx, "marking a transfer running; stopping it", "error", err)
		job.Stop()
		return started, fmt.Errorf("recording the transfer's start: %w", err)
	}
	if state == StateStopped || state == StateInterrupted {
		// A stop or a shutdown claimed it between the insert and the job's start, so it must not
		// keep running.
		job.Stop()
	}
	s.changed(rw.id, state, rw.operation, rw.sources, rw.destination)
	s.log.InfoContext(ctx, "transfer started", "seq", seq, "job", job.ID)

	select {
	case <-rn.ended:
	case <-time.After(launchGrace):
	case <-asked.Done():
	}
	launchErr := ""
	select {
	case <-rn.ended:
		launchErr = rn.launchErr
		rn.quiet = rn.quiet || (launchErr != "" && asked.Err() == nil)
	default:
	}
	if launchErr == "" && !rw.dryRun && owner == nil {
		s.notifier.Notify(ctx, notifications.NotificationEventJobStarted, jobPayload(seq, rw.operation, rw.sources, rw.destination))
	}
	if launchErr != "" {
		return started, errors.New(launchErr)
	}
	return started, nil
}

// prepare builds the plan and the row's values from a Spec.
func (s *Service) prepare(ctx context.Context, r Spec) (row, error) {
	rw := row{
		operation: operations.RecordedOperation(r.Form.Operation), sources: r.Sources,
		destination: r.Destination, dryRun: r.DryRun, retryOf: r.RetryOf,
	}
	if r.Plan != nil {
		rw.plan = *r.Plan
	} else {
		plan, err := operations.BuildPlan(ctx, r.Form)
		if err != nil {
			return row{}, err
		}
		rw.plan = plan
		if rw.sources == nil {
			rw.sources, rw.destination = r.Form.Ends()
		}
		if rw.args, err = r.Form.MarshalArgs(); err != nil {
			return row{}, err
		}
	}
	// Check prebuilt plans (from a retry or a resume) as well as built ones, so that nothing is
	// recorded that rclone could not run as it is.
	if err := rw.plan.Check(); err != nil {
		return row{}, fmt.Errorf("the transfer's plan: %w", err)
	}
	if !operations.IsRecordedOperation(rw.operation) {
		return row{}, fmt.Errorf("unknown operation %q", r.Form.Operation)
	}
	preset := r.Preset

	switch {
	case r.RetryOf != "":
		// A retry keeps the settings and the origin of its original.
		of, err := s.inherited(ctx, r.RetryOf)
		if err != nil {
			return row{}, err
		}
		rw.args, rw.preset, rw.dryRun, rw.origin = of.args, of.preset, of.dryRun, of.origin
	default:
		rw.origin = r.Origin
	}
	if rw.sources == nil {
		rw.sources = []string{}
	}
	if rw.dryRun || rw.plan.DryRun() {
		rw.dryRun = true
		rw.plan = rw.plan.WithDryRun()
		preset = withoutDryRun(preset)
	}
	// A retry keeps its original's preset, which was cleaned the same way when it started.
	if r.RetryOf == "" && preset != nil {
		raw, err := json.Marshal(preset)
		if err != nil {
			return row{}, err
		}
		rw.preset = raw
	}
	return rw, nil
}

// inherited reads the values that a retry takes from the transfer it retries.
func (s *Service) inherited(ctx context.Context, id string) (row, error) {
	var (
		of                     row
		args, preset, originID sql.NullString
		originName             sql.NullString
	)
	err := s.db.R.QueryRowContext(ctx, `SELECT args, preset, is_dry_run, origin_kind, origin_id,
		origin_name FROM transfers WHERE id = ?`, id).
		Scan(&args, &preset, &of.dryRun, &of.origin.Kind, &originID, &originName)
	if errors.Is(err, sql.ErrNoRows) {
		return row{}, ErrNotFound
	}
	if err != nil {
		return row{}, err
	}
	if args.Valid {
		of.args = json.RawMessage(args.String)
	}
	if preset.Valid {
		of.preset = json.RawMessage(preset.String)
	}
	of.origin.ID, of.origin.Name = originID.String, originName.String
	return of, nil
}

func groupOf(id string) string { return "transfer/" + id }

func newID(now time.Time) string {
	return fmt.Sprintf("%d-%s", now.UnixMilli(), ids.Hex(3))
}

// nullable returns v as a column value: NULL when it is empty, and its text otherwise.
func nullable[T ~string | ~[]byte](v T) any {
	if len(v) == 0 {
		return nil
	}
	return string(v)
}

func (s *Service) insert(ctx context.Context, rw row) (int64, error) {
	sources, err := json.Marshal(rw.sources)
	if err != nil {
		return 0, err
	}
	request, err := json.Marshal(rw.plan)
	if err != nil {
		return 0, err
	}
	var seq int64
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `INSERT INTO transfers (id, seq, created_ms, state,
			operation, sources, destination, is_dry_run, origin_kind, origin_id, origin_name, args,
			preset, request, stats_group, retry_of)
			VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transfers), ?, 'queued', ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
			rw.id, s.now().UnixMilli(), rw.operation, string(sources), nullable(rw.destination),
			rw.dryRun, rw.origin.Kind, nullable(rw.origin.ID), nullable(rw.origin.Name),
			nullable(rw.args), nullable(rw.preset), string(request), groupOf(rw.id),
			nullable(rw.retryOf)).Scan(&seq)
	})
	return seq, err
}

// markRunning records that the job started. If a stop or a shutdown claimed the transfer
// meanwhile, its state is kept.
func (s *Service) markRunning(ctx context.Context, id string, startedMS int64) (State, error) {
	var state State
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `UPDATE transfers SET started_ms = ?,
			state = CASE WHEN state = 'queued' THEN 'running' ELSE state END
			WHERE id = ? RETURNING state`, startedMS, id).Scan(&state)
	})
	return state, err
}

// refused records a transfer whose job could not start as failed, with the error.
func (s *Service) refused(ctx context.Context, rw row, seq int64, cause error) {
	group := groupOf(rw.id)
	ended, errText := stateOf(textOf(cause), outcome{})
	var state State
	// Start waits for this, so a refusal is tried again only once, not for a minute as an end is.
	err := s.retryWith(ctx, s.endWaits[:min(1, len(s.endWaits))], func() error {
		var err error
		state, err = s.endRow(ctx, rw.id, ended, errText, true)
		return err
	})
	if err != nil {
		s.log.ErrorContext(ctx, "recording a refused transfer", "error", err)
	}
	rclone.DeleteGroup(ctx, group)
	s.log.WarnContext(ctx, "transfer refused", "seq", seq, "error", cause)
	if state == "" {
		s.mu.Lock()
		delete(s.owners, rw.id)
		s.mu.Unlock()
		return
	}
	s.said(ctx, rw.id, state, 0, false) // Start returns the refusal, so the desktop isn't told
	s.retain(ctx)
}

// endRow writes only the end of a transfer: the current time, its state and its error, saved so
// that it can be translated later (saveText). A claim that holds (interrupted, or stopped when
// keepStop is set) keeps its own state and error. It writes the whole end of a refused start, and
// the end of a finished transfer when the full end with its files can't be written. It returns ""
// when the row had already ended.
func (s *Service) endRow(ctx context.Context, id string, state State, errText i18n.Text, keepStop bool) (State, error) {
	var final State
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `UPDATE transfers SET ended_ms = ?,
			error = CASE WHEN state = 'interrupted' OR (state = 'stopped' AND ?) THEN error ELSE ? END,
			state = CASE WHEN state = 'interrupted' OR (state = 'stopped' AND ?) THEN state ELSE ? END
			WHERE id = ? AND ended_ms IS NULL RETURNING state`,
			s.now().UnixMilli(), keepStop, nullable(saveText(errText)), keepStop, state, id).Scan(&final)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	})
	return final, err
}

// retryEnd runs write, which writes an end, until it succeeds or has been retried after each of
// endWaits. Trying again is safe, because only a row with no end is written. It is also worth
// it, because a transfer whose end is never written stays running until the next start. Once a
// shutdown has begun, it stops trying, because Shutdown waits for the ends only a few seconds.
func (s *Service) retryEnd(ctx context.Context, write func() error) error {
	return s.retryWith(ctx, s.endWaits, write)
}

// retryWith calls write until it succeeds, waiting each of waits in turn between attempts.
func (s *Service) retryWith(ctx context.Context, waits []time.Duration, write func() error) error {
	for i := 0; ; i++ {
		err := write()
		if err == nil || i == len(waits) || s.stopping.Load() {
			return err
		}
		s.log.WarnContext(ctx, "writing a transfer's end; trying again", "in", waits[i], "error", err)
		s.sleep(waits[i])
	}
}

// sleep waits for d, or until a shutdown begins.
func (s *Service) sleep(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-s.shutdown:
	}
}

// finish is a transfer's end handler (the job's OnFinish). It works out the end from the errors
// of the job and its steps, and writes it once with the totals and the last files. Then it
// deletes the stats group and reports the end.
func (s *Service) finish(rn *running) {
	defer s.ends.Done()
	ctx := logs.With(context.Background(), logs.Transfer(rn.id), logs.StatsGroup(rn.group),
		logs.Operation(string(rn.operation)), logs.Job(rn.job.ID))
	job := rn.job // its fields are final, because OnFinish runs after the job's finish() sets them
	out := outcomeOf(rn.rec)
	output, err := json.Marshal(out)
	if err != nil {
		output = nil
	}
	state, errText := stateOf(words(job.Error), out)
	s.mu.Lock()
	summary := withLiveTotal(summaryOf(rn.stats, job.Duration), rn.live)
	s.mu.Unlock()
	finalStats, _ := json.Marshal(summary)
	snaps := rn.stats.Transferred()
	failures, failedAll := rn.rec.Failures()
	if failedAll > len(failures) {
		s.log.InfoContext(ctx, "a sync's failures past the ledger's cap are not kept", "failed", failedAll, "kept", len(failures))
	}
	stepOf := stepMatcher(rn.plan, rn.rec.Steps())
	// A stop claim holds unless the plan had already returned on its own. In that case the claim
	// landed between the job's end and this write, and the job's own end (its error and its
	// notification) is what really happened. A shutdown's claim always holds, because it decides
	// what a restart resumes.
	keepStop := !rn.ranOutAlone()

	var dropped Transfer
	end := endOf{
		snaps: snaps, failures: failures, stepOf: stepOf, finalStats: finalStats, output: output,
		errText: errText, state: state, keepStop: keepStop,
		dropIdle: rn.owner != nil && rn.owner.Quiet(state, errText.String(), &summary),
		dropped:  &dropped,
	}
	var final State
	err = s.retryEnd(ctx, func() error {
		var st State
		dropped = Transfer{}
		err := s.db.Write(ctx, func(tx *sql.Tx) error { return s.writeEnd(ctx, tx, rn.id, &st, end) })
		if err == nil {
			final = st
		}
		return err
	})
	if err != nil {
		// Its files and totals are lost, but the transfer still ends. Left open, it would show as
		// running (in the busy prompts, with no end reported) until the next start.
		s.log.ErrorContext(ctx, "recording a transfer's end; recording it without its files", "error", err)
		if final, err = s.endRow(ctx, rn.id, state, errText, keepStop); err != nil {
			s.log.ErrorContext(ctx, "recording a transfer's end", "error", err)
		}
	}
	s.mu.Lock()
	delete(s.running, rn.id)
	s.mu.Unlock()
	rclone.DeleteGroup(ctx, rn.group)

	if final == StateFailed {
		rn.launchErr = launchError(job.Error, rn.plan, out)
	}
	close(rn.ended)
	<-rn.launched
	if final == "" {
		s.mu.Lock()
		delete(s.owners, rn.id) // Recover wrote the end, and no end is reported
		s.mu.Unlock()
		return
	}
	if dropped.ID != "" {
		s.log.InfoContext(ctx, "transfer ended quietly; dropped", "seq", rn.seq)
		s.saidDropped(dropped)
		return
	}
	s.log.InfoContext(ctx, "transfer ended", "seq", rn.seq, "state", string(final), "error", errText.String())
	s.said(ctx, rn.id, final, summary.DurationMs/1000, !rn.quiet)
	s.retain(ctx)
}

// endOf holds what is written when a transfer finishes.
type endOf struct {
	snaps      []accounting.TransferSnapshot
	failures   []operations.Failure
	stepOf     func(accounting.TransferSnapshot) *int
	finalStats []byte
	output     []byte
	errText    i18n.Text
	state      State
	keepStop   bool
	// dropIdle is set for an owned transfer whose owner found its end quiet (Owner.Quiet). Its
	// row is deleted instead of ended, in the same transaction, so nothing ever reads it as ended.
	// dropped then holds the row as it was, with its end.
	dropIdle bool
	dropped  *Transfer
}

// writeEnd writes a finished transfer's end in tx: first its files, then the row. Only a row with
// no end is updated. final is set to the resulting state, or to "" when the transfer had already
// ended because Recover wrote its end.
func (s *Service) writeEnd(ctx context.Context, tx *sql.Tx, id string, final *State, e endOf) error {
	if e.dropIdle {
		// Only a row that nothing claimed (a stop or a shutdown) is dropped.
		t, err := scanTransfer(tx.QueryRowContext(ctx, `DELETE FROM transfers
			WHERE id = ? AND ended_ms IS NULL AND state = 'running' RETURNING `+transferCols, id))
		switch {
		case err == nil:
			now := s.now().UnixMilli()
			t.State, t.EndedAt = e.state, &now
			t = t.WithErrorText(e.errText)
			var stats Summary
			if json.Unmarshal(e.finalStats, &stats) == nil {
				t.Stats = &stats
			}
			*e.dropped, *final = t, e.state
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
	}
	m, err := newFileMerger(ctx, tx)
	if err != nil {
		return err
	}
	defer m.close()
	for _, snap := range e.snaps {
		if err := m.add(ctx, id, rowOf(snap, e.stepOf)); err != nil {
			return err
		}
	}
	// Add a sync's failures as rclone's logger reported them, because the snapshots keep only its
	// last files. A failure that is also in a snapshot still makes only one row.
	for _, f := range e.failures {
		if err := m.add(ctx, id, loggedRow(f)); err != nil {
			return err
		}
	}
	if err := m.trim(ctx); err != nil {
		return err
	}
	err = tx.QueryRowContext(ctx, `UPDATE transfers SET ended_ms = ?, final_stats = ?,
		job_output = ?,
		error = CASE WHEN state = 'interrupted' OR (state = 'stopped' AND ?) THEN error ELSE ? END,
		state = CASE WHEN state = 'interrupted' OR (state = 'stopped' AND ?) THEN state ELSE ? END
		WHERE id = ? AND ended_ms IS NULL RETURNING state`,
		s.now().UnixMilli(), string(e.finalStats), nullable(e.output), e.keepStop, nullable(saveText(e.errText)),
		e.keepStop, e.state, id).Scan(final)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // ended already (Recover wrote it)
	}
	return err
}

// summaryOf returns a transfer's totals from its stats group, with the job's duration.
func summaryOf(stats *accounting.StatsInfo, duration float64) Summary {
	return Summary{
		Bytes: stats.GetBytes(), TotalBytes: rclone.StatsOf(stats, true).TotalBytes,
		Transfers: stats.GetTransfers(), Checks: stats.GetChecks(), Errors: stats.GetErrors(),
		// DeletedDirs and Renames add their argument and return the total.
		Deletes: stats.GetDeletes() + stats.DeletedDirs(0), Renames: stats.Renames(0),
		DurationMs: int64(duration*1000 + 0.5),
	}
}

// withLiveTotal keeps the total from the transfer's last tick when it is larger. A transfer's
// total only grows while it runs, but once it ends, its stats group no longer counts the files it
// was in the middle of. A stop would then read as all but done ("Stopped at 100%" for a big file
// stopped at 1%).
func withLiveTotal(sum Summary, live *bus.TransferProgress) Summary {
	if live != nil && live.TotalBytes > sum.TotalBytes {
		sum.TotalBytes = live.TotalBytes
	}
	return sum
}

// said reports an end that was just written. It calls Options.Ended and the owner, then tells
// the pages, the notification targets and, when desktop is set, the desktop. The notification
// targets and the desktop are never told about a dry run, a stop or an owned transfer (its owner
// tells them). Options.Ended runs first because it drops the cached listings that the
// transfer changed, and a page lists again as soon as it hears about the end.
func (s *Service) said(ctx context.Context, id string, state State, durationSeconds int64, desktop bool) {
	if s.reported != nil {
		defer s.reported(id)
	}
	s.mu.Lock()
	owner := s.owners[id]
	delete(s.owners, id)
	s.mu.Unlock()
	t, err := s.get(ctx, id)
	if err != nil {
		s.log.ErrorContext(ctx, "reading an ended transfer", "error", err)
		return
	}
	s.tellEnd(owner, t)
	s.changed(t.ID, t.State, t.Operation, t.Sources, t.Destination)
	if !t.IsDryRun && owner == nil && (state == StateCompleted || state == StateFailed) {
		p := jobPayload(t.Seq, t.Operation, t.Sources, t.Destination)
		p.DurationSeconds = &durationSeconds
		event := notifications.NotificationEventJobCompleted
		if state == StateFailed {
			event, p.Error = notifications.NotificationEventJobFailed, s.FailureText(ctx, t).Local()
		}
		s.notifier.Notify(ctx, event, p)
		if desktop {
			s.toast(ctx, event, t)
		}
	}
}

// tellEnd calls Options.Ended with t, and then its owner, if it has one.
func (s *Service) tellEnd(owner Owner, t Transfer) {
	if s.onEnded != nil {
		s.onEnded(t)
	}
	if owner != nil {
		owner.Ended(t)
	}
}

// saidDropped reports the end of an owned transfer whose end was quiet, which writeEnd dropped
// from the record. Options.Ended and the owner get it as it ended. The pages are told that
// it is gone (StateDropped), never that it ended, so a list of ended transfers never shows it.
// Nobody else is told about it.
func (s *Service) saidDropped(t Transfer) {
	if s.reported != nil {
		defer s.reported(t.ID)
	}
	s.mu.Lock()
	owner := s.owners[t.ID]
	delete(s.owners, t.ID)
	s.mu.Unlock()
	s.tellEnd(owner, t)
	s.changed(t.ID, StateDropped, t.Operation, t.Sources, t.Destination)
}

// toast shows a transfer's end as a desktop notification, whatever notification targets are set,
// so that a transfer that ends while nobody is watching isn't silent. Clicking it opens the
// transfer in History. It is shown as a toast or not at all, never as a dialog, because History
// and the tray show the end too.
func (s *Service) toast(ctx context.Context, event notifications.NotificationEvent, t Transfer) {
	title, body := s.ToastText(ctx, t)
	s.notifier.Desktop(ctx, event, jobPayload(t.Seq, t.Operation, t.Sources, t.Destination), notifications.Desktop{
		Title: title, Body: body, Route: "/history?id=" + url.QueryEscape(t.ID), ToastOnly: true,
	})
}

// ToastText returns the title and body of the desktop notification for t's end (see toastOf). A
// schedule's scheduler shows it for a failed run, with its own title.
func (s *Service) ToastText(ctx context.Context, t Transfer) (title, body string) {
	failed := 0
	if t.State == StateFailed && t.ID != "" {
		if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM transfer_files
			WHERE transfer_id = ? AND outcome = 'failed'`, t.ID).Scan(&failed); err != nil {
			s.log.WarnContext(ctx, "counting a transfer's failed files", "error", err)
		}
	}
	return toastOf(t, failed)
}

// Check builds and checks a transfer as Start does, and records nothing. Like Start, it reads
// the sources. A schedule's Save uses it.
func (s *Service) Check(ctx context.Context, f operations.Form) error {
	_, err := s.prepare(ctx, Spec{Form: f})
	return err
}

// Script returns the transfer that Start would run for the form, for a script
// (operations.Plan.Script). Nothing is started or recorded.
func (s *Service) Script(ctx context.Context, f operations.Form, goos, config string) (operations.Script, error) {
	p, err := s.prepare(ctx, Spec{Form: f})
	if err != nil {
		return operations.Script{}, err
	}
	return p.plan.Script(s.exe, goos, config)
}

// Landings says where each source of a copy or a move would end up, for the page to show under
// its destination. It builds the plan as Start does, reading whether each source is a file or a
// folder, and records nothing. A form that Start would refuse returns that refusal.
func (s *Service) Landings(ctx context.Context, f operations.Form) ([]operations.Landing, error) {
	p, err := s.prepare(ctx, Spec{Form: f})
	if err != nil {
		return nil, err
	}
	return p.plan.Landings, nil
}

// toastOf returns the title and body of the desktop notification for a transfer's end, in plain
// words and in the app's language. For example, "Copy finished" with "Photos → gdrive:Photos",
// or "Sync failed" with "12 files couldn't be copied to gdrive:Photos". When no file failed (for
// example, when the source doesn't exist), the body shows the paths and the error. Paths and
// errors are redacted, as they are for the notification targets, because a connection string can
// contain a secret.
func toastOf(t Transfer, failedFiles int) (title, body string) {
	sources := make([]string, len(t.Sources))
	for i, src := range t.Sources {
		sources[i] = logs.Redact(src)
	}
	from := strings.Join(sources, ", ")
	if len(sources) > 2 {
		n := len(sources) - 2
		// i18n: A transfer's sources in a notification: the first two, then how many more there are.
		from = i18n.N("%s and %d more", "%s and %d more", n, strings.Join(sources[:2], ", "), n)
	}
	to := logs.Redact(t.Destination)
	what := from
	switch {
	case from == "":
		what = to
	case to != "":
		what = from + " → " + to
	}
	if t.State != StateFailed {
		return finishedTitle(t.Operation), what
	}
	title = failedTitle(t.Operation)
	if failedFiles > 0 {
		return title, failedFilesText(t.Operation, failedFiles, from, to)
	}
	errText := logs.Redact(t.ErrorText().Local())
	switch {
	case what == "":
		return title, errText
	case errText == "":
		return title, what
	}
	// i18n: A failed transfer's notification: its sources and destination, and the error.
	return title, i18n.T("%s — %s", what, errText)
}

// finishedTitle is the title of the notification for a transfer that ended well.
func finishedTitle(operation operations.Operation) string {
	switch operation {
	case operations.OperationCopy:
		return i18n.T("Copy finished")
	case operations.OperationMove:
		return i18n.T("Move finished")
	case operations.OperationSync:
		return i18n.T("Sync finished")
	case operations.OperationBisync:
		return i18n.T("Bisync finished")
	case operations.OperationDelete:
		return i18n.T("Delete finished")
	case operations.OperationPurge:
		return i18n.T("Purge finished")
	case operations.OperationDownload:
		return i18n.T("Download finished")
	case operations.OperationCleanup:
		// i18n: A notification's title: emptying a remote's trash has finished.
		return i18n.T("Cleanup finished")
	}
	return i18n.T("Transfer finished")
}

// failedTitle is the title of the notification for a transfer that failed.
func failedTitle(operation operations.Operation) string {
	switch operation {
	case operations.OperationCopy:
		return i18n.T("Copy failed")
	case operations.OperationMove:
		return i18n.T("Move failed")
	case operations.OperationSync:
		return i18n.T("Sync failed")
	case operations.OperationBisync:
		return i18n.T("Bisync failed")
	case operations.OperationDelete:
		return i18n.T("Delete failed")
	case operations.OperationPurge:
		return i18n.T("Purge failed")
	case operations.OperationDownload:
		return i18n.T("Download failed")
	case operations.OperationCleanup:
		// i18n: A notification's title: emptying a remote's trash has failed.
		return i18n.T("Cleanup failed")
	}
	return i18n.T("Transfer failed")
}

// failedFilesText says how many files of a transfer failed, and where they were going: to the
// destination, or from the sources when there is none. The ledger keeps only the first maxFailed,
// so that many or more is "at least".
func failedFilesText(operation operations.Operation, n int, from, to string) string {
	atLeast := n >= maxFailed
	if atLeast {
		n = maxFailed
	}
	if to == "" {
		switch operation {
		case operations.OperationDelete, operations.OperationPurge:
			if atLeast {
				return i18n.N("At least %d file couldn't be deleted from %s", "At least %d files couldn't be deleted from %s", n, n, from)
			}
			return i18n.N("%d file couldn't be deleted from %s", "%d files couldn't be deleted from %s", n, n, from)
		case operations.OperationCleanup:
			if atLeast {
				return i18n.N("At least %d file couldn't be cleaned up from %s", "At least %d files couldn't be cleaned up from %s", n, n, from)
			}
			return i18n.N("%d file couldn't be cleaned up from %s", "%d files couldn't be cleaned up from %s", n, n, from)
		}
		if atLeast {
			return i18n.N("At least %d file couldn't be copied from %s", "At least %d files couldn't be copied from %s", n, n, from)
		}
		return i18n.N("%d file couldn't be copied from %s", "%d files couldn't be copied from %s", n, n, from)
	}
	switch operation {
	case operations.OperationMove:
		if atLeast {
			return i18n.N("At least %d file couldn't be moved to %s", "At least %d files couldn't be moved to %s", n, n, to)
		}
		return i18n.N("%d file couldn't be moved to %s", "%d files couldn't be moved to %s", n, n, to)
	case operations.OperationBisync:
		if atLeast {
			return i18n.N("At least %d file couldn't be synced to %s", "At least %d files couldn't be synced to %s", n, n, to)
		}
		return i18n.N("%d file couldn't be synced to %s", "%d files couldn't be synced to %s", n, n, to)
	case operations.OperationDownload:
		if atLeast {
			return i18n.N("At least %d file couldn't be downloaded to %s", "At least %d files couldn't be downloaded to %s", n, n, to)
		}
		return i18n.N("%d file couldn't be downloaded to %s", "%d files couldn't be downloaded to %s", n, n, to)
	}
	// A copy, and a sync, whose failed files are files that it couldn't copy.
	if atLeast {
		return i18n.N("At least %d file couldn't be copied to %s", "At least %d files couldn't be copied to %s", n, n, to)
	}
	return i18n.N("%d file couldn't be copied to %s", "%d files couldn't be copied to %s", n, n, to)
}

func jobPayload(seq int64, operation operations.Operation, sources []string, destination string) notifications.Job {
	return notifications.Job{JobID: seq, Operation: string(operation), Sources: sources, Destination: destination}
}

func (s *Service) changed(id string, state State, operation operations.Operation, sources []string, destination string) {
	s.bus.Publish(bus.TransfersChanged, bus.TransfersChangedData{
		ID: id, State: string(state), Operation: string(operation), Sources: sources, Destination: destination,
	})
}

// retain deletes ended transfers and their files, so that only the keepEnded that ended last
// remain. It orders by the end, not the start, so a long transfer is never deleted at its own
// end. Open transfers and those marked for resume are kept.
func (s *Service) retain(ctx context.Context) {
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM transfers WHERE id IN (
			SELECT id FROM transfers WHERE ended_ms IS NOT NULL AND resume = 0
			ORDER BY ended_ms DESC, id DESC LIMIT -1 OFFSET ?)`, keepEnded)
		return err
	})
	if err != nil {
		s.log.ErrorContext(ctx, "trimming the transfer ledger", "error", err)
	}
}

// Stop stops a transfer. It first claims the transfer as stopped, so that the "context canceled"
// error its job ends with is never recorded as a failure. Then it stops the job, and with it
// every step, since the steps run on the job's context. A transfer whose plan has already
// returned on its own is not running any more. Its own end is about to be written, and a claim
// that lands before that write doesn't hold.
func (s *Service) Stop(ctx context.Context, id string) error {
	s.mu.Lock()
	rn := s.running[id]
	s.mu.Unlock()
	if rn != nil && rn.ranOutAlone() {
		return ErrNotRunning
	}
	var (
		operation   operations.Operation
		sources     string
		destination sql.NullString
	)
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `UPDATE transfers SET state = 'stopped'
			WHERE id = ? AND state IN ('queued','running')
			RETURNING operation, sources, destination`, id).Scan(&operation, &sources, &destination)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotRunning
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	rn = s.running[id]
	s.mu.Unlock()
	// If the job hasn't started yet, Start stops it when it finds the claim.
	if rn != nil {
		rn.job.Stop()
	}
	var srcs []string
	_ = json.Unmarshal([]byte(sources), &srcs)
	s.changed(id, StateStopped, operation, srcs, destination.String)
	return nil
}

// StopAll stops every queued and running transfer, a watcher's or a schedule's run included, and
// returns how many it stopped. A transfer that ended in the meantime counts as neither stopped
// nor failed. The errors of the others are joined.
func (s *Service) StopAll(ctx context.Context) (int, error) {
	active, err := s.Active(ctx)
	if err != nil {
		return 0, err
	}
	var errs []error
	n := 0
	for _, t := range active {
		switch err := s.Stop(ctx, t.ID); {
		case err == nil:
			n++
		case !errors.Is(err, ErrNotRunning):
			errs = append(errs, err)
		}
	}
	return n, errors.Join(errs...)
}

// Interrupted returns how many transfers the previous process left queued or running. Recover
// marked them interrupted.
func (s *Service) Interrupted() int { return int(s.interrupted.Load()) }

// Recover runs once at startup, before any transfer starts. It marks the transfers that the
// previous process left open as interrupted, and gives every row without an end the previous
// process's last log time. Then it starts again the transfers that a restart for an update
// marked, as retries of themselves with only the steps that had not succeeded (see resumeOf).
// When this build can't start one again, that transfer fails with the reason (see
// resumeRefused).
func (s *Service) Recover(ctx context.Context, lastLogMS int64) error {
	if lastLogMS <= 0 {
		lastLogMS = s.now().UnixMilli()
	}
	type resumed struct {
		id, request, sources string
		operation            operations.Operation
		destination, output  sql.NullString
	}
	var todo []resumed
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE transfers SET state = 'interrupted'
			WHERE state IN ('queued','running')`)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err == nil {
			s.interrupted.Store(n)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE transfers SET ended_ms = MAX(created_ms, ?)
			WHERE ended_ms IS NULL`, lastLogMS); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, operation, request, sources, destination, job_output
			FROM transfers WHERE resume = 1 ORDER BY created_ms, id`)
		if err != nil {
			return err
		}
		if todo, err = db.Collect(rows, func(r db.Scanner) (resumed, error) {
			var x resumed
			err := r.Scan(&x.id, &x.operation, &x.request, &x.sources, &x.destination, &x.output)
			return x, err
		}); err != nil {
			return err
		}
		// Clear the marks before the transfers start, so that a transfer that crashes the app
		// doesn't come back on the next start.
		_, err = tx.ExecContext(ctx, `UPDATE transfers SET resume = 0 WHERE resume = 1`)
		return err
	})
	if err != nil {
		return fmt.Errorf("recovering the transfer ledger: %w", err)
	}
	// A resume that fails is shown on the desktop. It is found while the core is still starting,
	// before the UI subscribes to the bus, and the notification service holds it until then.
	var wg sync.WaitGroup
	refuse := func(id string, cause error) {
		if t, ok := s.resumeRefused(ctx, id, cause); ok {
			s.toast(ctx, notifications.NotificationEventJobFailed, t)
		}
	}
	for _, r := range todo {
		var sources []string
		whole, err := operations.ParsePlan([]byte(r.request))
		if err != nil {
			refuse(r.id, err) // a plan from a newer build, after a downgrade
			continue
		}
		plan := resumeOf(whole, []byte(r.output.String))
		if len(plan.Steps) == 0 {
			s.log.InfoContext(ctx, "not resuming a transfer: each of its steps had succeeded", "transfer", r.id)
			continue
		}
		_ = json.Unmarshal([]byte(r.sources), &sources)
		if len(plan.Steps) < len(whole.Steps) {
			// What is left reads from fewer places. As for a retry, list the sources of the
			// remaining steps.
			sources = make([]string, len(plan.Steps))
			for i, st := range plan.Steps {
				sources[i] = st.Source()
			}
		}
		wg.Go(func() {
			started, err := s.Start(ctx, Spec{
				Form: operations.Form{Operation: r.operation}, Plan: &plan, Sources: sources,
				Destination: r.destination.String, RetryOf: r.id,
			})
			switch {
			case err != nil && started.ID == "":
				// Nothing was recorded, because this build's rclone refused the plan. The reason
				// is recorded on the transfer that was to be resumed.
				refuse(r.id, err)
			case err != nil:
				// It started and failed at once, and the new transfer records that. Start keeps
				// a failure that it returns quiet, but no page asked for this one, so the
				// desktop is told, as for a refusal.
				s.log.WarnContext(ctx, "resuming a transfer", "transfer", r.id, "as", started.ID, "error", err)
				if t, err := s.get(ctx, started.ID); err == nil && t.State == StateFailed {
					s.toast(ctx, notifications.NotificationEventJobFailed, t)
				}
			default:
				s.log.InfoContext(ctx, "transfer resumed", "transfer", r.id, "as", started.ID)
			}
		})
	}
	wg.Wait()
	return nil
}

// resumeRefused records that the transfer id, which a restart for an update marked to start
// again, could not start. The transfer fails, with the reason as its error. It returns the
// transfer, and whether the desktop should be told. The desktop is not told about a dry run, or
// about a transfer whose state changed meanwhile.
func (s *Service) resumeRefused(ctx context.Context, id string, cause error) (Transfer, bool) {
	s.log.WarnContext(ctx, "not resuming a transfer", "transfer", id, "error", cause)
	var marked bool
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE transfers SET state = 'failed', error = ?
			WHERE id = ? AND state = 'interrupted'`,
			// i18n: Why a transfer that was running before an update failed. The value is the reason.
			i18n.SaveText(i18n.M("Couldn't start again after the update: %v", cause)), id)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		marked = n > 0
		return err
	})
	if err != nil {
		s.log.ErrorContext(ctx, "recording a refused resume", "transfer", id, "error", err)
		return Transfer{}, false
	}
	if !marked {
		return Transfer{}, false
	}
	t, err := s.get(ctx, id)
	if err != nil {
		s.log.ErrorContext(ctx, "reading a refused resume", "transfer", id, "error", err)
		return Transfer{}, false
	}
	s.changed(t.ID, t.State, t.Operation, t.Sources, t.Destination)
	return t, !t.IsDryRun
}

// Shutdown stops the service. No transfer starts after it. The running transfers are claimed as
// interrupted and their jobs are stopped. With resume (a restart for an update), the resumable
// ones are also marked to start again. Their end handlers get up to shutdownWait to finish.
func (s *Service) Shutdown(ctx context.Context, resume bool) {
	s.startMu.Lock()
	s.stopping.Store(true)
	s.startMu.Unlock()
	s.shutdownOnce.Do(func() { close(s.shutdown) })

	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		type open struct {
			id        string
			operation operations.Operation
			origin    OriginKind
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, operation, origin_kind FROM transfers
			WHERE state IN ('queued','running')`)
		if err != nil {
			return err
		}
		// Read all the rows and close them before running updates in the same transaction.
		all, err := db.Collect(rows, func(r db.Scanner) (open, error) {
			var o open
			err := r.Scan(&o.id, &o.operation, &o.origin)
			return o, err
		})
		if err != nil {
			return err
		}
		for _, o := range all {
			again := resume && resumable(o.operation, o.origin)
			if _, err := tx.ExecContext(ctx, `UPDATE transfers SET state = 'interrupted', resume = ?
				WHERE id = ? AND state IN ('queued','running')`, again, o.id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.log.ErrorContext(ctx, "claiming the running transfers", "error", err)
	}
	s.mu.Lock()
	toStop := make([]*jobs.Job, 0, len(s.running))
	for _, rn := range s.running {
		toStop = append(toStop, rn.job)
	}
	s.mu.Unlock()
	for _, job := range toStop {
		job.Stop()
	}
	if !syncx.Wait(ctx, &s.ends, shutdownWait) {
		s.log.WarnContext(ctx, "transfers still ending after the shutdown's wait")
	}
}

// Resumable reports whether a restart for an update would start t again. t must still be open
// and of a resumable kind. A transfer that is being stopped is not open, so Shutdown won't mark
// it.
func Resumable(t Transfer) bool {
	return (t.State == StateQueued || t.State == StateRunning) && resumable(t.Operation, t.Origin.Kind)
}

// resumable reports whether a restart for an update starts a transfer again. The transfer must
// have been started from the pages (an operation page, the Commander or a template), and must
// not be a bisync, because an interrupted bisync needs a resync. A watcher's or a schedule's run
// isn't started again, because its watcher or schedule runs again on its own.
func resumable(operation operations.Operation, origin OriginKind) bool {
	fromPages := origin == OriginPage || origin == OriginCommander || origin == OriginTemplate
	return fromPages && operation != operations.OperationBisync
}

// withoutDryRun returns a dry run's preset without dry_run in its config group, so that Duplicate
// doesn't reopen it as a dry run. The preset itself doesn't change.
func withoutDryRun(preset *operations.Form) *operations.Form {
	g := preset.Groups()
	if g == nil {
		return preset
	}
	if _, ok := g.Config["dry_run"]; !ok {
		return preset
	}
	// A copy through JSON shares nothing with the preset.
	raw, err := json.Marshal(preset)
	if err != nil {
		return preset
	}
	var out operations.Form
	if err := json.Unmarshal(raw, &out); err != nil {
		return preset
	}
	delete(out.Groups().Config, "dry_run")
	return &out
}
