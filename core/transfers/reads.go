package transfers

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

// maxPage is the most rows that one page of a list can hold.
const maxPage = 200

const transferCols = `id, seq, created_ms, started_ms, ended_ms, state, resume, operation, sources,
	destination, is_dry_run, origin_kind, origin_id, origin_name, stats_group, retry_of, error,
	final_stats`

func scanTransfer(sc db.Scanner) (Transfer, error) {
	var (
		t                                    Transfer
		started, ended                       sql.NullInt64
		sources                              string
		destination, retryOf, errText, final sql.NullString
		originID, originName                 sql.NullString
	)
	err := sc.Scan(&t.ID, &t.Seq, &t.CreatedAt, &started, &ended, &t.State, &t.Resume,
		&t.Operation, &sources, &destination, &t.IsDryRun, &t.Origin.Kind, &originID, &originName,
		&t.Group, &retryOf, &errText, &final)
	if err != nil {
		return Transfer{}, err
	}
	if started.Valid {
		t.StartedAt = &started.Int64
	}
	if ended.Valid {
		t.EndedAt = &ended.Int64
	}
	// The error is saved so that it can be translated (i18n.Save). It is read in English, and the
	// API gives it in the app's language.
	t.Destination, t.RetryOf, t.saved = destination.String, retryOf.String, errText.String
	t.Error = i18n.Saved(t.saved).String()
	t.Origin.ID, t.Origin.Name = originID.String, originName.String
	if err := json.Unmarshal([]byte(sources), &t.Sources); err != nil {
		return Transfer{}, fmt.Errorf("transfer %s sources: %w", t.ID, err)
	}
	if final.Valid {
		t.Stats = &Summary{}
		if err := json.Unmarshal([]byte(final.String), t.Stats); err != nil {
			return Transfer{}, fmt.Errorf("transfer %s stats: %w", t.ID, err)
		}
	}
	return t, nil
}

// query reads transfers, and adds the live numbers of those that are running.
func (s *Service) query(ctx context.Context, q string, args ...any) ([]Transfer, error) {
	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	out, err := db.Collect(rows, scanTransfer)
	if err != nil {
		return nil, err
	}
	s.withLive(out)
	return out, nil
}

func (s *Service) withLive(ts []Transfer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range ts {
		if rn := s.running[ts[i].ID]; rn != nil && rn.live != nil && ts[i].EndedAt == nil {
			p := *rn.live
			ts[i].Live = &p
		}
	}
}

func (s *Service) get(ctx context.Context, id string) (Transfer, error) {
	ts, err := s.query(ctx, `SELECT `+transferCols+` FROM transfers WHERE id = ?`, id)
	if err != nil {
		return Transfer{}, err
	}
	if len(ts) == 0 {
		return Transfer{}, ErrNotFound
	}
	return ts[0], nil
}

// Active returns every transfer that has not ended, newest first (the Transfers page's `active`
// list).
func (s *Service) Active(ctx context.Context) ([]Transfer, error) {
	return s.query(ctx, `SELECT `+transferCols+` FROM transfers WHERE ended_ms IS NULL
		ORDER BY created_ms DESC, id DESC`)
}

// EndedQuery selects one page of ended transfers. Before is a transfer's id, and asks for the
// transfers created before it. After is an end time in ms, and asks for the transfers that ended at
// or after it. Without either, the query returns the newest page. State and Search narrow every
// page alike, so that paging goes through the same rows.
type EndedQuery struct {
	Before string `json:"before"`
	After  int64  `json:"after"`
	Limit  int    `json:"limit"`
	// State keeps the transfers that ended in it. StateStopped also takes the interrupted ones.
	// "" keeps them all.
	State State `json:"state"`
	// Search keeps the transfers that it is found in (see Matches).
	Search string `json:"search"`
}

var ErrNotAnEnd = errs.New("Not a state that a transfer ends in")

// Ended returns one page of the ended transfers, ordered by (created_ms, id) descending.
func (s *Service) Ended(ctx context.Context, q EndedQuery) (EndedPage, error) {
	limit := q.Limit
	if limit <= 0 || limit > maxPage {
		limit = maxPage
	}
	where, args := `ended_ms IS NOT NULL`, []any{}
	switch q.State {
	case "":
	case StateCompleted, StateFailed:
		where, args = where+` AND state = ?`, append(args, q.State)
	case StateStopped:
		where, args = where+` AND state IN (?, ?)`, append(args, StateStopped, StateInterrupted)
	default:
		return EndedPage{}, fmt.Errorf("%w: %q", ErrNotAnEnd, q.State)
	}
	order := `created_ms DESC, id DESC`
	switch {
	case q.After > 0:
		// The oldest end first, so that a page that stops at the limit leaves no gap before the
		// next one. The page is sorted newest first before it is returned.
		where, args, order = where+` AND ended_ms >= ?`, append(args, q.After), `ended_ms, id`
	case q.Before != "":
		created, ok, err := s.createdOf(ctx, q.Before)
		if err != nil {
			return EndedPage{}, err
		}
		if !ok {
			return EndedPage{Items: []Transfer{}}, nil
		}
		where, args = where+` AND (created_ms, id) < (?, ?)`, append(args, created, q.Before)
	}
	items, err := s.ended(ctx, `SELECT `+transferCols+` FROM transfers WHERE `+where+
		` ORDER BY `+order, args, limit+1, q.Search)
	if err != nil {
		return EndedPage{}, err
	}
	page := EndedPage{Items: items}
	if len(items) > limit {
		page.Items, page.More = items[:limit], true
	}
	if q.After > 0 {
		sortNewest(page.Items)
	}
	return page, nil
}

// ended returns the first n rows of query that search is found in. Without a search, the query
// gets a LIMIT. With one, it keeps reading rows until n of them match, because the rows that don't
// match can't be counted in SQL.
func (s *Service) ended(ctx context.Context, query string, args []any, n int, search string) ([]Transfer, error) {
	if strings.TrimSpace(search) == "" {
		return s.query(ctx, query+` LIMIT ?`, append(args, n)...)
	}
	rows, err := s.db.R.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Transfer{}
	for len(out) < n && rows.Next() {
		t, err := scanTransfer(rows)
		if err != nil {
			return nil, err
		}
		if Matches(t, search) {
			out = append(out, t)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.withLive(out)
	return out, nil
}

// Matches reports whether search is found in t's number (#12), operation, destination, sources,
// error or origin's name, ignoring case. The operation is searched by its key ("sync") and by its
// name (OperationName), and the name and the error are searched as History shows them, in the
// app's language, and in English. An empty search matches every transfer.
func Matches(t Transfer, search string) bool {
	needle := strings.ToLower(strings.TrimSpace(search))
	if needle == "" {
		return true
	}
	name := operationName(t.Operation)
	texts := append([]string{"#" + strconv.FormatInt(t.Seq, 10), string(t.Operation), name.String(), name.Local(),
		t.Destination, t.Error, t.ErrorText().Local(), t.Origin.Name}, t.Sources...)
	return slices.ContainsFunc(texts, func(text string) bool {
		return strings.Contains(strings.ToLower(text), needle)
	})
}

// sortNewest orders transfers the way the ended pages do, with the newest created first.
func sortNewest(ts []Transfer) {
	slices.SortFunc(ts, func(a, b Transfer) int {
		return cmp.Or(cmp.Compare(b.CreatedAt, a.CreatedAt), strings.Compare(b.ID, a.ID))
	})
}

// createdOf returns the created_ms for a cursor. It reads it from the cursor's row, or else from
// the time that its id begins with, because the row may have been trimmed since the page loaded
// it.
func (s *Service) createdOf(ctx context.Context, id string) (int64, bool, error) {
	var created int64
	err := s.db.R.QueryRowContext(ctx, `SELECT created_ms FROM transfers WHERE id = ?`, id).Scan(&created)
	if err == nil {
		return created, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}
	ms, _, _ := strings.Cut(id, "-")
	created, perr := strconv.ParseInt(ms, 10, 64)
	return created, perr == nil, nil
}

func (s *Service) Get(ctx context.Context, id string) (Detail, error) {
	t, err := s.get(ctx, id)
	if err != nil {
		return Detail{}, err
	}
	d := Detail{Transfer: t, Retries: []Ref{}, General: []GeneralError{}}
	var preset sql.NullString
	if err := s.db.R.QueryRowContext(ctx, `SELECT preset FROM transfers WHERE id = ?`, id).Scan(&preset); err != nil {
		return Detail{}, err
	}
	if preset.Valid {
		d.Preset = &operations.Form{}
		if err := json.Unmarshal([]byte(preset.String), d.Preset); err != nil {
			return Detail{}, fmt.Errorf("transfer %s preset: %w", t.ID, err)
		}
	}
	if t.RetryOf != "" {
		ref := Ref{ID: t.RetryOf}
		err := s.db.R.QueryRowContext(ctx, `SELECT seq, state FROM transfers WHERE id = ?`, t.RetryOf).Scan(&ref.Seq, &ref.State)
		switch {
		case err == nil:
			d.RetryOf = &ref
		case !errors.Is(err, sql.ErrNoRows):
			return Detail{}, err
		}
	}
	rows, err := s.db.R.QueryContext(ctx, `SELECT id, seq, state FROM transfers WHERE retry_of = ?
		ORDER BY created_ms, id`, id)
	if err != nil {
		return Detail{}, err
	}
	if d.Retries, err = db.Collect(rows, func(r db.Scanner) (Ref, error) {
		var ref Ref
		err := r.Scan(&ref.ID, &ref.Seq, &ref.State)
		return ref, err
	}); err != nil {
		return Detail{}, err
	}
	if t.EndedAt != nil {
		r, err := s.Retryable(ctx, id)
		if err != nil {
			return Detail{}, err
		}
		d.General, d.Retryable = r.General, len(r.Items)
	}
	return d, nil
}

// FilesQuery selects one page of a transfer's files with one outcome. Before is the cursor of the
// last file shown, or "" for the newest page.
type FilesQuery struct {
	Outcome Outcome
	Before  string
	Limit   int
}

// Files returns one page of a transfer's files with one outcome, newest first, with their total.
func (s *Service) Files(ctx context.Context, id string, q FilesQuery) (FilesPage, error) {
	switch q.Outcome {
	case OutcomeTransferred, OutcomeFailed, OutcomeChecked:
	default:
		return FilesPage{}, fmt.Errorf("unknown outcome %q", q.Outcome)
	}
	limit := q.Limit
	if limit <= 0 || limit > maxPage {
		limit = maxPage
	}
	var page FilesPage
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM transfer_files
			WHERE transfer_id = ? AND outcome = ?`, id, q.Outcome).Scan(&page.Total); err != nil {
			return err
		}
		where, args := `transfer_id = ? AND outcome = ?`, []any{id, q.Outcome}
		if q.Before != "" {
			at, rowid, err := parseFileCursor(q.Before)
			if err != nil {
				return err
			}
			where += ` AND (completed_ms, rowid) < (?, ?)`
			args = append(args, at, rowid)
		}
		rows, err := tx.QueryContext(ctx, `SELECT rowid, outcome, src_fs, name, input, what,
			dst_fs, size, bytes, error, completed_ms FROM transfer_files WHERE `+where+`
			ORDER BY completed_ms DESC, rowid DESC LIMIT ?`, append(args, limit+1)...)
		if err != nil {
			return err
		}
		page.Items, err = db.Collect(rows, func(r db.Scanner) (File, error) {
			var (
				f                  File
				rowid              int64
				input, size, bytes sql.NullInt64
				what, dst, errText sql.NullString
				completed          sql.NullInt64
			)
			if err := r.Scan(&rowid, &f.Outcome, &f.SrcFs, &f.Name, &input, &what, &dst,
				&size, &bytes, &errText, &completed); err != nil {
				return File{}, err
			}
			if input.Valid {
				n := int(input.Int64)
				f.Step = &n
			}
			f.What, f.DstFs, f.Error = what.String, dst.String, errText.String
			f.Size, f.Bytes, f.CompletedAt = size.Int64, bytes.Int64, completed.Int64
			f.Cursor = fmt.Sprintf("%d:%d", f.CompletedAt, rowid)
			return f, nil
		})
		return err
	})
	if err != nil {
		return FilesPage{}, err
	}
	if len(page.Items) > limit {
		page.Items, page.More = page.Items[:limit], true
	}
	return page, nil
}

func parseFileCursor(c string) (int64, int64, error) {
	a, b, ok := strings.Cut(c, ":")
	at, err1 := strconv.ParseInt(a, 10, 64)
	rowid, err2 := strconv.ParseInt(b, 10, 64)
	if !ok || err1 != nil || err2 != nil {
		return 0, 0, fmt.Errorf("not a files cursor: %q", c)
	}
	return at, rowid, nil
}

// Live returns the latest numbers of the running transfers, by id. A page shows them until the
// next transfers.progress event arrives.
func (s *Service) Live() map[string]bus.TransferProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]bus.TransferProgress, len(s.running))
	for id, rn := range s.running {
		if rn.live != nil {
			out[id] = *rn.live
		}
	}
	return out
}

// IDOf returns the id of the transfer whose number is seq, or ErrNotFound when the record has no
// such transfer.
func (s *Service) IDOf(ctx context.Context, seq int64) (string, error) {
	var id string
	err := s.db.R.QueryRowContext(ctx, `SELECT id FROM transfers WHERE seq = ?`, seq).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

// Open reports whether the transfer id is still queued or running. A transfer that the record no
// longer has is not open.
func (s *Service) Open(ctx context.Context, id string) (bool, error) {
	var state State
	err := s.db.R.QueryRowContext(ctx, `SELECT state FROM transfers WHERE id = ?`, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return state == StateQueued || state == StateRunning, nil
}
