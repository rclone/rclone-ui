package transfers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

var fileOps = map[string]string{
	operations.OpCopy: operations.OpCopyFile,
	operations.OpMove: operations.OpMoveFile,
}

type failedFile struct {
	srcFs, name, what, dstFs, err string
	step                          *int
}

type retrySource struct {
	plan     operations.Plan
	out      *outcome
	failed   []failedFile
	recorded i18n.Text
	errors   int64
}

func (s *Service) retrySource(ctx context.Context, id string) (retrySource, error) {
	var src retrySource
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		var (
			request                string
			state                  State
			output, errText, final sql.NullString
		)
		err := tx.QueryRowContext(ctx, `SELECT request, state, job_output, error, final_stats
			FROM transfers WHERE id = ?`, id).Scan(&request, &state, &output, &errText, &final)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		src.recorded = words(errText.String)
		var summary Summary
		if final.Valid && json.Unmarshal([]byte(final.String), &summary) == nil {
			src.errors = summary.Errors
		}
		if src.plan, err = operations.ParsePlan([]byte(request)); err != nil {
			return nil
		}
		if out, ok := parseOutcome([]byte(output.String)); ok && state != StateStopped && state != StateInterrupted {
			src.out = &out
		}
		rows, err := tx.QueryContext(ctx, `SELECT src_fs, name, what, dst_fs, error, input
			FROM transfer_files WHERE transfer_id = ? AND outcome = 'failed' ORDER BY name, src_fs`, id)
		if err != nil {
			return err
		}
		src.failed, err = db.Collect(rows, func(r db.Scanner) (failedFile, error) {
			var (
				f                   failedFile
				what, dst, errText2 sql.NullString
				step                sql.NullInt64
			)
			if err := r.Scan(&f.srcFs, &f.name, &what, &dst, &errText2, &step); err != nil {
				return failedFile{}, err
			}
			f.what, f.dstFs, f.err = what.String, dst.String, errText2.String
			if step.Valid {
				i := int(step.Int64)
				f.step = &i
			}
			return f, nil
		})
		return err
	})
	return src, err
}

func (s *Service) Retryable(ctx context.Context, id string) (Retryable, error) {
	t, err := s.get(ctx, id)
	if err != nil {
		return Retryable{}, err
	}
	r := Retryable{Items: []RetryItem{}, General: []GeneralError{}}
	if t.EndedAt == nil {
		return r, nil
	}
	src, err := s.retrySource(ctx, id)
	if err != nil {
		return Retryable{}, err
	}
	r.Items = retryPlan(src)
	if len(r.Items) > 0 {
		if err := retryOf(r.Items, src.plan).Check(); err != nil {
			r.Items, r.refused = []RetryItem{}, cantRun(t.Operation, err)
			r.Refused = r.refused.String()
		}
	}
	shown := map[string]bool{}
	for _, f := range src.failed {
		shown[f.err] = true
	}
	r.General = generalErrors(src.recorded, src.plan, src.out, shown)
	return r, nil
}

func cantRun(operation operations.Operation, err error) i18n.Text {
	switch operation {
	case operations.OperationCopy:
		return i18n.M("Copy can't run: %v", err)
	case operations.OperationMove:
		return i18n.M("Move can't run: %v", err)
	case operations.OperationSync:
		return i18n.M("Sync can't run: %v", err)
	case operations.OperationBisync:
		return i18n.M("Bisync can't run: %v", err)
	case operations.OperationDelete:
		return i18n.M("Delete can't run: %v", err)
	case operations.OperationPurge:
		return i18n.M("Purge can't run: %v", err)
	case operations.OperationDownload:
		return i18n.M("Download can't run: %v", err)
	case operations.OperationCleanup:
		// i18n: Why a cleanup (emptying a remote's trash) can't be retried. The value is the reason.
		return i18n.M("Cleanup can't run: %v", err)
	}
	// i18n: Why a transfer can't be retried. The value is the reason.
	return i18n.M("This transfer can't run: %v", err)
}

func (s *Service) Retry(ctx context.Context, id string, keys [][2]string) (Started, error) {
	t, err := s.get(ctx, id)
	if err != nil {
		return Started{}, err
	}
	if t.EndedAt == nil {
		return Started{}, ErrNotEnded
	}
	src, err := s.retrySource(ctx, id)
	if err != nil {
		return Started{}, err
	}
	items := retryPlan(src)
	if len(keys) > 0 {
		items = slices.DeleteFunc(items, func(it RetryItem) bool { return !slices.Contains(keys, it.Key) })
	}
	if len(items) == 0 {
		return Started{}, ErrNoRetry
	}
	plan := retryOf(items, src.plan)
	sources := make([]string, len(items))
	for i, it := range items {
		sources[i] = it.Source
	}
	return s.Start(ctx, Spec{
		Form: operations.Form{Operation: t.Operation}, Plan: &plan, Sources: sources,
		Destination: t.Destination, RetryOf: id,
	})
}

func retryPlan(src retrySource) []RetryItem {
	items := []RetryItem{}
	var failed []failedFile
	for _, f := range src.failed {
		if f.name != "" && (f.what == "" || f.what == "transferring") {
			failed = append(failed, f)
		}
	}
	slices.SortStableFunc(failed, func(a, b failedFile) int { return strings.Compare(a.name, b.name) })
	steps := src.plan.Steps

	if src.plan.Whole() {
		// A sync's failed files are copied. The sync itself is never re-run limited to those
		// files, because with delete_excluded that would delete everything else at the
		// destination. Bisync keeps its own record of both sides, so the way to retry it is to
		// run it again.
		if steps[0].Op == operations.OpSync {
			for _, f := range failed {
				items = append(items, fileItem(nil, f, operations.OpCopyFile, steps[0]))
			}
		}
		return items
	}

	errorOf := func(i int) string {
		if src.out != nil && i < len(src.out.Errors) {
			return src.out.Errors[i]
		}
		return ""
	}
	missed := src.errors > int64(len(src.failed))
	var folders []int
	for i, st := range steps {
		if _, ok := fileOps[st.Op]; ok && (src.out == nil || errorOf(i) != "") {
			folders = append(folders, i)
		}
	}
	filesOf := map[int][]failedFile{}
	for _, f := range failed {
		home := -1
		switch {
		case f.step != nil:
			if slices.Contains(folders, *f.step) {
				home = *f.step
			}
		case len(folders) == 1:
			home = folders[0]
		}
		if home >= 0 {
			filesOf[home] = append(filesOf[home], f)
		}
	}
	for i, st := range steps {
		if files := filesOf[i]; files != nil && (!missed || errorOf(i) == "") {
			for _, f := range files {
				items = append(items, fileItem(&i, f, fileOps[st.Op], st))
			}
			continue
		}
		if e := errorOf(i); e != "" {
			items = append(items, stepItem(i, st, e))
		}
	}
	return items
}

func fileItem(index *int, f failedFile, op string, st operations.Step) RetryItem {
	var stepIndex *int
	if index != nil {
		i := *index
		stepIndex = &i
	}
	return RetryItem{
		Key: [2]string{f.srcFs, f.name}, Kind: "file", Label: f.name,
		Source: operations.Step{Src: st.Src, SrcRemote: f.name}.Source(), Error: f.err, What: f.what,
		Step: stepIndex, DstFs: f.dstFs,
		step: operations.Step{Op: op, Src: st.Src, SrcRemote: f.name, Dst: st.Dst, DstRemote: f.name},
	}
}

func stepItem(i int, st operations.Step, err string) RetryItem {
	f, remote := st.Src, st.SrcRemote
	if f == "" {
		f, remote = st.Dst, st.DstRemote
	}
	text := words(err)
	return RetryItem{
		Key: [2]string{f, remote}, Kind: "step", Label: st.Label(),
		Source: st.Source(), Error: text.String(), Step: &i, DstFs: st.Dst, step: st, text: text,
	}
}

func resumeOf(p operations.Plan, output []byte) operations.Plan {
	out, ok := parseOutcome(output)
	if !ok || len(out.Errors) != len(p.Steps) {
		return p
	}
	left := p
	left.Steps = nil
	for i, st := range p.Steps {
		if out.Errors[i] != "" {
			left.Steps = append(left.Steps, st)
		}
	}
	return left
}

func retryOf(items []RetryItem, of operations.Plan) operations.Plan {
	steps := make([]operations.Step, len(items))
	for i, it := range items {
		steps[i] = it.step
	}
	return operations.Plan{
		V: operations.PlanVersion, Steps: steps, Config: of.Config, Filter: of.Filter,
		Concurrency: of.Concurrency,
	}
}
