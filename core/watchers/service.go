// Package watchers keeps pairs of folders the same, the way Dropbox or Google Drive keep a local
// folder in sync. A watcher is two folders, each local or on a remote, that a bisync runs on
// every minute. The watchers are stored in the app's database. The scheduler (scheduler.go)
// starts their runs through the transfer service, with the watcher as their origin, and records how
// each run ended. Every change publishes watchers.changed.
package watchers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/runs"
)

// Every is how often the scheduler runs each watcher.
const Every = time.Minute

type Options struct {
	DB        *db.DB
	Bus       *bus.Bus
	Transfers runs.Transfers
	// Notifier sends watcher.failed to the notification targets and shows it on the desktop.
	Notifier notifications.Notifier
	// Run runs one-shot work (a run's start) on its own goroutine, with a context that ends when
	// the core shuts down. It is the core itself.
	Run syncx.Runner
	// Tick is how often the scheduler runs the watchers. 0 means Every.
	Tick time.Duration
	// Workdir is bisync's working folder, where it keeps its listings. "" means rclone's own,
	// which the Bisync page uses too.
	Workdir string
}

type Service struct {
	o   Options
	log *slog.Logger
	// runs claims, starts and frees the watchers' runs.
	runs *runs.Engine[mode, runData]

	mu     sync.Mutex
	states map[string]*state
}

// New returns a Service. Its scheduler starts with Run.
func New(o Options) *Service {
	if o.Tick <= 0 {
		o.Tick = Every
	}
	s := &Service{o: o, log: logs.Logger(logs.CompTransfers, "watchers"), states: map[string]*state{}}
	s.runs = runs.New(runs.Options{Name: "watchers", Transfers: o.Transfers, Runner: o.Run, Log: s.log}, (*owner)(s))
	return s
}

var ErrNotFound = errs.NotFound("watcher", "This watcher no longer exists.")

// columns are the columns that scan reads.
const columns = `id, name, path_a, path_b, paused, created_at, baselined, last_run_at, last_result,
	last_error, last_change_at, last_change_id, last_transfer_id, attention, deleted_side`

func scan(row db.Scanner) (*Watcher, error) {
	var w Watcher
	var lastRun, lastChange sql.NullInt64
	var lastError string
	if err := row.Scan(&w.ID, &w.Name, &w.PathA, &w.PathB, &w.Paused, &w.CreatedAt, &w.Baselined,
		&lastRun, &w.LastResult, &lastError, &lastChange, &w.LastChangeID, &w.LastTransferID,
		&w.Attention, &w.DeletedSide); err != nil {
		return nil, err
	}
	// The last error is saved so that it can be translated (i18n.Save). It is read in English,
	// and the API gives it in the app's language.
	w.lastError = i18n.Saved(lastError)
	w.LastError = w.lastError.String()
	if lastRun.Valid {
		w.LastRunAt = &lastRun.Int64
	}
	if lastChange.Valid {
		w.LastChangeAt = &lastChange.Int64
	}
	return &w, nil
}

func (s *Service) read(ctx context.Context, id string) (*Watcher, error) {
	var w *Watcher
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		var err error
		w, err = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM watchers WHERE id = ?`, id))
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read watcher %s: %w", id, err)
	}
	return w, nil
}

func (s *Service) readAll(ctx context.Context) ([]*Watcher, error) {
	var out []*Watcher
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM watchers ORDER BY name COLLATE NOCASE, id`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, scan)
		return err
	})
	return out, err
}

func (s *Service) Get(ctx context.Context, id string) (*Watcher, error) {
	w, err := s.read(ctx, id)
	if err != nil {
		return nil, err
	}
	w.Resyncing = resyncing(s.runs.Current(), w.ID)
	return w, nil
}

// List returns every watcher, sorted by name.
func (s *Service) List(ctx context.Context) ([]*Watcher, error) {
	current := s.runs.Current()
	ws, err := s.readAll(ctx)
	for _, w := range ws {
		w.Resyncing = resyncing(current, w.ID)
	}
	return ws, err
}

// check normalizes in before it is saved: it trims the name and the paths, and refuses a missing
// name or path, a path that rclone would refuse or misread, and two paths where one folder is
// the other or holds it. Errors name their field: name, pathA or pathB.
func check(in Input) (Input, error) {
	out := Input{ID: in.ID, Name: strings.TrimSpace(in.Name), PathA: strings.TrimSpace(in.PathA), PathB: strings.TrimSpace(in.PathB)}
	if out.Name == "" {
		return Input{}, errs.Field("name", "Please enter a name for the watcher")
	}
	for _, p := range []struct {
		field, path string
		missing     func() error
	}{
		{"pathA", out.PathA, func() error { return errs.Field("pathA", "Please select Folder A") }},
		{"pathB", out.PathB, func() error { return errs.Field("pathB", "Please select Folder B") }},
	} {
		if p.path == "" {
			return Input{}, p.missing()
		}
		if err := location.FieldRefusal(p.field, p.path); err != nil {
			return Input{}, err
		}
	}
	switch overlap(out.PathA, out.PathB) {
	case same:
		return Input{}, errs.Field("pathB", "Folder A and Folder B are the same folder.")
	case inside:
		return Input{}, errs.Field("pathB", "Folder A and Folder B can't be inside each other.")
	}
	return out, nil
}

// How two folders overlap.
const (
	apart = iota
	same
	inside
)

// overlap tells whether two paths that location.Problem accepted are the same folder, or one
// holds the other. It compares them as rclone reads them, so `/x/` and `/x`, or `:local:/x` and
// `/x`, are the same. Two remotes are only the same when they have the same name: an alias of a
// local folder isn't seen as that folder. Local paths ignore case on macOS and Windows, whose
// disks usually do.
func overlap(a, b string) int {
	fa, errA := location.Split(a)
	fb, errB := location.Split(b)
	if errA != nil || errB != nil || fa.Config != fb.Config || fa.Anchor != fb.Anchor {
		return apart
	}
	ra, rb := fa.Rel, fb.Rel
	if fa.Name == ":local" && (runtime.GOOS == "darwin" || runtime.GOOS == "windows") {
		ra, rb = strings.ToLower(ra), strings.ToLower(rb)
	}
	switch {
	case ra == rb:
		return same
	case ra == "" || rb == "" || strings.HasPrefix(rb, ra+"/") || strings.HasPrefix(ra, rb+"/"):
		return inside
	}
	return apart
}

// Save creates a watcher (when in.ID is empty) or edits one. A name is used once, whatever its
// case. Changing a folder clears the baseline and what the watcher needed, so the next run merges
// the two folders again. A new watcher, or one whose folders changed, runs at once unless it is
// paused.
func (s *Service) Save(ctx context.Context, in Input) (*Watcher, error) {
	in, err := check(in)
	if err != nil {
		return nil, err
	}
	creating := in.ID == ""
	if creating {
		in.ID = uuid.NewString()
	}
	moved := creating
	err = s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM watchers WHERE name = ? COLLATE NOCASE AND id != ?`,
			in.Name, in.ID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return errs.Field("name", "A watcher called %s exists already.", in.Name)
		}
		if creating {
			_, err := tx.ExecContext(ctx, `INSERT INTO watchers (id, name, path_a, path_b, created_at)
				VALUES (?, ?, ?, ?, ?)`, in.ID, in.Name, in.PathA, in.PathB, db.NowMS())
			return err
		}
		var a, b string
		err := tx.QueryRowContext(ctx, `SELECT path_a, path_b FROM watchers WHERE id = ?`, in.ID).Scan(&a, &b)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		moved = a != in.PathA || b != in.PathB
		_, err = tx.ExecContext(ctx, `UPDATE watchers SET name = ?, path_a = ?, path_b = ?,
			baselined = CASE WHEN ? THEN 0 ELSE baselined END,
			attention = CASE WHEN ? THEN '' ELSE attention END,
			deleted_side = CASE WHEN ? THEN '' ELSE deleted_side END
			WHERE id = ?`, in.Name, in.PathA, in.PathB, moved, moved, moved, in.ID)
		return err
	})
	if err != nil {
		if errs.Is(err) || errors.Is(err, ErrNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("save watcher %s: %w", in.ID, err)
	}
	s.changed()
	if moved {
		s.kick(in.ID, modeNormal)
	}
	return s.Get(ctx, in.ID)
}

// Delete removes a watcher. Its run, if one is in progress, is stopped. The two folders and
// their files stay as they are.
func (s *Service) Delete(ctx context.Context, id string) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM watchers WHERE id = ?`, id)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return fmt.Errorf("remove watcher %s: %w", id, err)
	}
	if n == 0 {
		return ErrNotFound
	}
	s.mu.Lock()
	delete(s.states, id)
	s.mu.Unlock()
	s.runs.Forget(ctx, id, true)
	s.changed()
	return nil
}

// Pause stops a watcher from running every minute. A run in progress goes on.
func (s *Service) Pause(ctx context.Context, id string) error {
	return s.setPaused(ctx, id, true)
}

// Resume runs a paused watcher again every minute, and at once.
func (s *Service) Resume(ctx context.Context, id string) error {
	if err := s.setPaused(ctx, id, false); err != nil {
		return err
	}
	s.kick(id, modeNormal)
	return nil
}

func (s *Service) setPaused(ctx context.Context, id string, paused bool) error {
	if err := s.update(ctx, id, `paused = ?`, paused); err != nil {
		return err
	}
	s.changed()
	return nil
}

// update sets columns of the watcher id. It returns ErrNotFound when there is none.
func (s *Service) update(ctx context.Context, id, set string, args ...any) error {
	var n int64
	err := s.o.DB.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE watchers SET `+set+` WHERE id = ?`, append(args, id)...)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return fmt.Errorf("update watcher %s: %w", id, err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SyncNow runs a watcher at once, even when it is paused. It does nothing more while a run is in
// progress, or while the watcher needs the user (Resync or Force).
func (s *Service) SyncNow(ctx context.Context, id string) error {
	if _, err := s.read(ctx, id); err != nil {
		return err
	}
	s.kick(id, modeNow)
	return nil
}

// Resync runs one merge of the two folders, newer wins, which deletes nothing. If it succeeds,
// the watcher is baselined and no longer needs the user. While it is asked for and hasn't ended,
// the watcher shows Initializing. While a run is in progress, the merge runs after it.
func (s *Service) Resync(ctx context.Context, id string) error {
	if _, err := s.read(ctx, id); err != nil {
		return err
	}
	s.kick(id, modeResync)
	return nil
}

// Force deletes in the other folder the files that were deleted in one folder, after bisync's
// max-delete safety stopped the watcher: it runs once with force. When every file was deleted,
// bisync won't run even with force, so the empty folder is synced to the other one instead, and a
// merge sets the baseline. If it succeeds, the watcher no longer needs the user. It does nothing
// for a watcher that didn't stop for deletes.
//
// Before that sync, the empty folder is checked, here so that the page can say why nothing
// happened, and again when the run starts (stillEmpty). It returns the error when the folder
// can't be listed. A folder that has files again is left to the run, which records it and asks
// for a resync.
func (s *Service) Force(ctx context.Context, id string) error {
	w, err := s.read(ctx, id)
	if err != nil {
		return err
	}
	if w.Attention == AttentionEmptied {
		if err := s.stillEmpty(ctx, w); err != nil && !errors.Is(err, errRefilled) {
			return err
		}
	}
	if w.Attention == AttentionDeletes || w.Attention == AttentionEmptied {
		s.kick(id, modeForce)
	}
	return nil
}

func (s *Service) changed() { s.o.Bus.Publish(bus.WatchersChanged, nil) }

// Keeps reports whether a watcher already keeps the folders a and b the same, in either order.
func (s *Service) Keeps(ctx context.Context, a, b string) (bool, error) {
	ws, err := s.readAll(ctx)
	if err != nil {
		return false, err
	}
	for _, w := range ws {
		if overlap(w.PathA, a) == same && overlap(w.PathB, b) == same ||
			overlap(w.PathA, b) == same && overlap(w.PathB, a) == same {
			return true, nil
		}
	}
	return false, nil
}

// Active counts the watchers that run while the app is open: those that aren't paused and don't
// wait for the user.
func (s *Service) Active(ctx context.Context) (int, error) {
	var n int
	err := s.o.DB.Read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM watchers WHERE paused = 0 AND attention = ''`).Scan(&n)
	})
	return n, err
}
