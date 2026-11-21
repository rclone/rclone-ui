package transfers

import (
	"context"
	"database/sql"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs/accounting"

	"github.com/rclone/rclone-ui/core/operations"
)

// The limits on transfer_files rows per transfer. For failed files, the first 1,000 to fail are
// kept, the same number that a plan's Record keeps for a sync. For each other outcome, the newest
// 1,000 files are kept.
const (
	maxFailed = operations.MaxFailures
	maxKept   = 1000
)

// fileRow is one finished file as it is stored in transfer_files.
type fileRow struct {
	outcome     Outcome
	srcFs, name string
	input       *int
	what, dstFs string
	size, bytes int64
	err         string
	completedMS int64
}

// changingChecks are the labels of rclone's checking transfers (NewCheckingTransfer) that change
// the file: a server-side move, a delete, a rename that --track-renames found, and dedupe's merge.
// rclone's other checking labels only read: checking, hashing, listing, bisync's "listing file -
// Path1" and "listing dir - Path2", "computing hash with --download-hash", and the hasher's
// importing.
var changingChecks = []string{"moving", "deleting", "renaming", "merging"}

// rowOf turns rclone's snapshot of a finished file into a row. The row records a failure (whatever
// the action was), a check that changed nothing, or an action that changed the file (a transfer, a
// delete, a move…). stepOf returns the plan step that the file belongs to.
func rowOf(snap accounting.TransferSnapshot, stepOf func(accounting.TransferSnapshot) *int) fileRow {
	r := fileRow{
		srcFs: snap.SrcFs, name: snap.Name, what: snap.What, dstFs: snap.DstFs,
		size: snap.Size, bytes: snap.Bytes, completedMS: snap.CompletedAt.UnixMilli(),
		input: stepOf(snap),
	}
	switch {
	case snap.Error != nil:
		r.outcome, r.err = OutcomeFailed, snap.Error.Error()
	case snap.Checked && !slices.Contains(changingChecks, snap.What):
		r.outcome = OutcomeChecked
	default:
		r.outcome = OutcomeTransferred
	}
	return r
}

// loggedRow is a file that a sync failed to transfer, as rclone's sync logger reported it
// (operations.Failure). It has no step, because a whole sync has no steps to tell apart.
func loggedRow(f operations.Failure) fileRow {
	return fileRow{
		outcome: OutcomeFailed, srcFs: f.SrcFs, name: f.Name, what: "transferring", dstFs: f.DstFs,
		size: f.Size, err: f.Err, completedMS: f.At.UnixMilli(),
	}
}

// fileMerger writes finished files into transfer_files inside one transaction. Failed files are
// keyed by (src_fs, name), replaced when they fail again, and capped at maxFailed. Other files
// are upserted, then trimmed to the newest maxKept of their outcome.
type fileMerger struct {
	tx                                     *sql.Tx
	update, countFailed, insertFailed, put *sql.Stmt
	trimmed                                map[string]map[Outcome]bool
	// failed is each transfer's count of failed rows. It is read from the table at the first
	// failure, then increased as rows are added. Past maxFailed, a failure only replaces the
	// existing row for its file.
	failed map[string]int
}

func newFileMerger(ctx context.Context, tx *sql.Tx) (*fileMerger, error) {
	m := &fileMerger{tx: tx, trimmed: map[string]map[Outcome]bool{}, failed: map[string]int{}}
	var err error
	if m.update, err = tx.PrepareContext(ctx, `UPDATE transfer_files SET input = ?, what = ?,
		dst_fs = ?, size = ?, bytes = ?, error = ?, completed_ms = ?
		WHERE transfer_id = ? AND outcome = 'failed' AND src_fs = ? AND name = ?`); err != nil {
		return nil, err
	}
	if m.countFailed, err = tx.PrepareContext(ctx, `SELECT COUNT(*) FROM transfer_files
		WHERE transfer_id = ? AND outcome = 'failed'`); err != nil {
		return nil, err
	}
	if m.insertFailed, err = tx.PrepareContext(ctx, `INSERT INTO transfer_files (transfer_id,
		outcome, src_fs, name, input, what, dst_fs, size, bytes, error, completed_ms)
		VALUES (?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`); err != nil {
		return nil, err
	}
	if m.put, err = tx.PrepareContext(ctx, `INSERT INTO transfer_files (transfer_id, outcome,
		src_fs, name, input, what, dst_fs, size, bytes, error, completed_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
		ON CONFLICT (transfer_id, outcome, src_fs, name) DO UPDATE SET input = excluded.input,
		what = excluded.what, dst_fs = excluded.dst_fs, size = excluded.size,
		bytes = excluded.bytes, completed_ms = excluded.completed_ms`); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *fileMerger) close() {
	for _, s := range []*sql.Stmt{m.update, m.countFailed, m.insertFailed, m.put} {
		if s != nil {
			_ = s.Close()
		}
	}
}

func (m *fileMerger) add(ctx context.Context, id string, r fileRow) error {
	if r.outcome == OutcomeFailed {
		res, err := m.update.ExecContext(ctx, r.input, r.what, r.dstFs, r.size, r.bytes, r.err,
			r.completedMS, id, r.srcFs, r.name)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return nil
		}
		n, counted := m.failed[id]
		if !counted {
			if err := m.countFailed.QueryRowContext(ctx, id).Scan(&n); err != nil {
				return err
			}
			m.failed[id] = n
		}
		if n >= maxFailed {
			return nil
		}
		if _, err := m.insertFailed.ExecContext(ctx, id, r.srcFs, r.name, r.input, r.what, r.dstFs,
			r.size, r.bytes, r.err, r.completedMS); err != nil {
			return err
		}
		m.failed[id] = n + 1
		return nil
	}
	if _, err := m.put.ExecContext(ctx, id, r.outcome, r.srcFs, r.name, r.input, r.what,
		r.dstFs, r.size, r.bytes, r.completedMS); err != nil {
		return err
	}
	if m.trimmed[id] == nil {
		m.trimmed[id] = map[Outcome]bool{}
	}
	m.trimmed[id][r.outcome] = true
	return nil
}

// trim keeps only the newest maxKept files of each outcome that got new files in this
// transaction.
func (m *fileMerger) trim(ctx context.Context) error {
	for id, outcomes := range m.trimmed {
		for o := range outcomes {
			if _, err := m.tx.ExecContext(ctx, `DELETE FROM transfer_files WHERE rowid IN (
				SELECT rowid FROM transfer_files WHERE transfer_id = ? AND outcome = ?
				ORDER BY completed_ms DESC, rowid DESC LIMIT -1 OFFSET ?)`, id, o, maxKept); err != nil {
				return err
			}
		}
	}
	return nil
}

// stepMatcher returns a function that finds the step of p that a finished file belongs to. It
// compares the file with the Fs names that each step opened. names comes from a Record and holds
// fs.ConfigString values, which are the names that rclone's snapshots use. A file step matches by
// its file and Fs, a purge by its folder, and any other step by either end. The file belongs to
// the only step that matches. When none matches, a plan with a single step gets that step. In
// every other case the result is nil. A whole sync or bisync has no steps to tell apart, so its
// result is always nil.
func stepMatcher(p operations.Plan, names []operations.StepRecord) func(accounting.TransferSnapshot) *int {
	if p.Whole() || len(names) != len(p.Steps) {
		return func(accounting.TransferSnapshot) *int { return nil }
	}
	return func(snap accounting.TransferSnapshot) *int {
		found := -1
		for i, st := range p.Steps {
			n := names[i]
			var match bool
			switch {
			case st.File():
				match = snap.Name == st.SrcRemote && (snap.SrcFs == "" || snap.SrcFs == n.SrcFs)
			case st.Op == operations.OpPurge:
				match = snap.SrcFs == n.SrcFs && strings.HasPrefix(snap.Name, strings.TrimSuffix(st.SrcRemote, "/")+"/")
			default:
				match = snap.SrcFs != "" && snap.SrcFs == n.SrcFs || snap.DstFs != "" && snap.DstFs == n.DstFs
			}
			if !match {
				continue
			}
			if found >= 0 {
				return nil // two steps match, so don't guess
			}
			found = i
		}
		if found < 0 && len(p.Steps) == 1 {
			found = 0
		}
		if found < 0 {
			return nil
		}
		return &found
	}
}
