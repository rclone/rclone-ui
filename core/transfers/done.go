package transfers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/rclone/rclone-ui/core/operations"
)

// DoneRequest is an operation that the app made at once, with no job of rclone's, such as a
// single-file delete in the Commander.
type DoneRequest struct {
	// Form is the operation's form, as a start of it would take it. Its sources are recorded.
	Form operations.Form
	// Origin is where the operation was made: the Commander.
	Origin Origin
	// Began is when the operation began. It ends now.
	Began time.Time
}

// Done records an operation that was made at once as a completed transfer, so that History lists
// it like every other. Its end is reported as a transfer's end is, except to the desktop, because
// the window that made it shows it already.
func (s *Service) Done(ctx context.Context, r DoneRequest) (Started, error) {
	operation := operations.RecordedOperation(r.Form.Operation)
	if !operations.IsRecordedOperation(operation) {
		return Started{}, fmt.Errorf("unknown operation %q", r.Form.Operation)
	}
	if !r.Origin.Kind.valid() {
		return Started{}, fmt.Errorf("unknown origin %q", r.Origin.Kind)
	}
	args, err := r.Form.MarshalArgs()
	if err != nil {
		return Started{}, err
	}
	now := s.now()
	if r.Began.IsZero() || r.Began.After(now) {
		r.Began = now
	}
	sources, _ := r.Form.Ends()
	if sources == nil {
		sources = []string{}
	}
	id := newID(now)
	srcs, err := json.Marshal(sources)
	if err != nil {
		return Started{}, err
	}
	// No job ran, so the plan has no steps, and there is nothing to retry.
	request, err := json.Marshal(operations.Plan{V: operations.PlanVersion})
	if err != nil {
		return Started{}, err
	}
	duration := now.Sub(r.Began).Milliseconds()
	stats, err := json.Marshal(Summary{DurationMs: duration})
	if err != nil {
		return Started{}, err
	}
	var seq int64
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `INSERT INTO transfers (id, seq, created_ms, started_ms,
			ended_ms, state, operation, sources, is_dry_run, origin_kind, origin_id, origin_name,
			args, request, stats_group, final_stats)
			VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transfers), ?, ?, ?, 'completed', ?, ?,
			0, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
			id, r.Began.UnixMilli(), r.Began.UnixMilli(), now.UnixMilli(), operation,
			string(srcs), r.Origin.Kind, nullable(r.Origin.ID), nullable(r.Origin.Name),
			nullable(args), string(request), groupOf(id), string(stats)).Scan(&seq)
	})
	if err != nil {
		return Started{}, fmt.Errorf("recording the %s: %w", r.Form.Operation, err)
	}
	s.said(ctx, id, StateCompleted, duration/1000, false)
	s.retain(ctx)
	return Started{ID: id, Seq: seq}, nil
}
