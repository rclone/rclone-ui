package transfers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/accounting"

	"github.com/rclone/rclone-ui/core/operations"
)

func (f *fixture) merge(id string, rows ...fileRow) {
	f.t.Helper()
	ctx := context.Background()
	err := f.db.Write(ctx, func(tx *sql.Tx) error {
		m, err := newFileMerger(ctx, tx)
		if err != nil {
			return err
		}
		defer m.close()
		for _, r := range rows {
			if err := m.add(ctx, id, r); err != nil {
				return err
			}
		}
		return m.trim(ctx)
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) count(id string, o Outcome) int {
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfer_files WHERE transfer_id = ? AND outcome = ?`, id, o).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// Failed files are keyed by (src_fs, name), replaced when they fail again, and capped at the
// first ones to fail. The other outcomes keep their newest files.
func TestFileMerge(t *testing.T) {
	f := newFixture(t)
	f.seed("1-aaaaaa", 1, map[string]any{"state": "running", "ended_ms": nil})
	failed := func(name, srcFs, err string, at int64) fileRow {
		return fileRow{outcome: OutcomeFailed, srcFs: srcFs, name: name, err: err, completedMS: at, what: "transferring"}
	}
	f.merge("1-aaaaaa", failed("a.txt", "/src", "permission denied", 1), failed("b.txt", "/src", "quota", 2))
	f.merge("1-aaaaaa", failed("b.txt", "/src", "quota (again)", 3), failed("a.txt", "/other", "x", 4))
	page, err := f.s.Files(context.Background(), "1-aaaaaa", FilesQuery{Outcome: OutcomeFailed})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, file := range page.Items {
		got[file.SrcFs+" "+file.Name] = file.Error
	}
	want := map[string]string{"/src a.txt": "permission denied", "/src b.txt": "quota (again)", "/other a.txt": "x"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("failed %v, want %v", got, want)
	}

	var many []fileRow
	for i := range maxFailed + 5 {
		many = append(many, failed(fmt.Sprintf("f%04d", i), "/src", "no", int64(10+i)))
	}
	f.merge("1-aaaaaa", many...)
	if n := f.count("1-aaaaaa", OutcomeFailed); n != maxFailed {
		t.Errorf("%d failed kept, want %d", n, maxFailed)
	}
	// At the cap, a file that failed before is still replaced.
	f.merge("1-aaaaaa", failed("a.txt", "/src", "now this", 9999))
	var e string
	if err := f.db.R.QueryRow(`SELECT error FROM transfer_files WHERE transfer_id = '1-aaaaaa' AND name = 'a.txt' AND src_fs = '/src'`).Scan(&e); err != nil {
		t.Fatal(err)
	}
	if e != "now this" {
		t.Errorf("a.txt error %q at the cap", e)
	}

	var moved []fileRow
	for i := range maxKept + 20 {
		moved = append(moved, fileRow{outcome: OutcomeTransferred, srcFs: "/src", name: fmt.Sprintf("m%04d", i), completedMS: int64(i)})
	}
	f.merge("1-aaaaaa", moved...)
	if n := f.count("1-aaaaaa", OutcomeTransferred); n != maxKept {
		t.Errorf("%d transferred kept, want %d", n, maxKept)
	}
	var oldest string
	if err := f.db.R.QueryRow(`SELECT name FROM transfer_files WHERE transfer_id = '1-aaaaaa' AND outcome = 'transferred' ORDER BY completed_ms LIMIT 1`).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	if oldest != "m0020" {
		t.Errorf("oldest kept %s, want the newest 1 000", oldest)
	}
	if n := f.count("1-aaaaaa", OutcomeChecked); n != 0 {
		t.Errorf("checked %d", n)
	}
}

// An end with more failures than the ledger keeps (from a group's last snapshots and a sync's
// logged failures, each as many as the cap) keeps the first maxFailed to fail, and is written in
// one pass. The merger reads a transfer's count of failed rows once, then counts the rows it
// adds.
func TestEndWithMoreFailuresThanKept(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	const id = "1-aaaaaa"
	f.seed(id, 1, map[string]any{"state": "running", "ended_ms": nil})
	failed := func(name string) fileRow {
		return fileRow{outcome: OutcomeFailed, srcFs: "/src", name: name, err: "denied", what: "transferring"}
	}
	f.merge(id, failed("tick-a"), failed("tick-b")) // from a tick, before the end

	at := time.UnixMilli(5000)
	end := endOf{
		stepOf:     func(accounting.TransferSnapshot) *int { return nil },
		finalStats: []byte(`{}`), state: StateFailed, errText: words("denied"), keepStop: true,
	}
	for i := range maxCompleted {
		end.snaps = append(end.snaps, accounting.TransferSnapshot{
			SrcFs: "/src", Name: fmt.Sprintf("s%05d", i), What: "transferring", Error: errors.New("denied"), CompletedAt: at,
		})
	}
	for i := range operations.MaxFailures {
		end.failures = append(end.failures, operations.Failure{SrcFs: "/src", Name: fmt.Sprintf("l%05d", i), Err: "denied", At: at})
	}
	began := time.Now()
	var final State
	if err := f.db.Write(ctx, func(tx *sql.Tx) error { return f.s.writeEnd(ctx, tx, id, &final, end) }); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > 5*time.Second {
		t.Errorf("the end took %s to write", took)
	}
	if n := f.count(id, OutcomeFailed); final != StateFailed || n != maxFailed {
		t.Fatalf("ended %q with %d failed, want failed with %d", final, n, maxFailed)
	}
	kept := func(name string) bool {
		var n int
		if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfer_files WHERE transfer_id = ? AND name = ?`, id, name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	last := fmt.Sprintf("s%05d", maxFailed-3)
	if !kept("tick-a") || !kept(last) || kept(fmt.Sprintf("s%05d", maxFailed-2)) || kept("l00000") {
		t.Errorf("not the first to fail: tick-a %v, %s %v, l00000 %v", kept("tick-a"), last, kept(last), kept("l00000"))
	}

	// The count comes from the table. It is read once for a transfer that has rows, and counted
	// up from there.
	f.seed("2-bbbbbb", 2, map[string]any{"state": "running", "ended_ms": nil})
	if err := f.db.Write(ctx, func(tx *sql.Tx) error {
		m, err := newFileMerger(ctx, tx)
		if err != nil {
			return err
		}
		defer m.close()
		for i := range maxFailed + 5 {
			if err := m.add(ctx, "2-bbbbbb", failed(fmt.Sprintf("f%05d", i))); err != nil {
				return err
			}
		}
		if err := m.add(ctx, id, failed("one more")); err != nil {
			return err
		}
		if m.failed["2-bbbbbb"] != maxFailed || m.failed[id] != maxFailed {
			t.Errorf("counted %v, want %d each", m.failed, maxFailed)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if n := f.count("2-bbbbbb", OutcomeFailed); n != maxFailed || kept("one more") {
		t.Errorf("%d failed kept, want %d", n, maxFailed)
	}
}

// A failure from rclone's sync logger and the snapshot of the same file, if the group still had
// it at the end, make only one failed row.
func TestLoggedFailureMergesWithItsSnapshot(t *testing.T) {
	f := newFixture(t)
	f.seed("1-aaaaaa", 1, map[string]any{"state": "running", "ended_ms": nil})
	at := time.UnixMilli(5000)
	snap := accounting.TransferSnapshot{Name: "aaa.txt", SrcFs: "/src", DstFs: "/dst", Size: 6,
		What: "transferring", Error: errors.New("permission denied"), CompletedAt: at}
	logged := operations.Failure{SrcFs: "/src", Name: "aaa.txt", DstFs: "/dst", Err: "permission denied", Size: 6, At: at}
	f.merge("1-aaaaaa", rowOf(snap, func(accounting.TransferSnapshot) *int { return nil }), loggedRow(logged))
	page, err := f.s.Files(context.Background(), "1-aaaaaa", FilesQuery{Outcome: OutcomeFailed})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Name != "aaa.txt" || page.Items[0].Error != "permission denied" ||
		page.Items[0].What != "transferring" || page.Items[0].DstFs != "/dst" || page.Items[0].Size != 6 {
		t.Errorf("failed %+v", page)
	}
}

func TestRowOf(t *testing.T) {
	none := func(accounting.TransferSnapshot) *int { return nil }
	at := time.UnixMilli(5000)
	for _, tc := range []struct {
		snap accounting.TransferSnapshot
		want Outcome
	}{
		{accounting.TransferSnapshot{Name: "a", What: "transferring", CompletedAt: at}, OutcomeTransferred},
		{accounting.TransferSnapshot{Name: "a", What: "deleting", Checked: true, CompletedAt: at}, OutcomeTransferred},
		{accounting.TransferSnapshot{Name: "a", What: "checking", Checked: true, CompletedAt: at}, OutcomeChecked},
		{accounting.TransferSnapshot{Name: "a", What: "checking", Checked: true, Error: errors.New("hash differs"), CompletedAt: at}, OutcomeFailed},
	} {
		r := rowOf(tc.snap, none)
		if r.outcome != tc.want || r.completedMS != 5000 {
			t.Errorf("%+v → %s", tc.snap, r.outcome)
		}
	}
}

// Which step a finished file belongs to. It is found by the names that rclone gave each step's Fs,
// which are not the strings that the plan opened them with.
func TestStepMatcher(t *testing.T) {
	p := operations.Plan{V: 1, Steps: []operations.Step{
		{Op: operations.OpCopyFile, Src: ":local:/data/", SrcRemote: "a.txt", Dst: ":local:/dst/", DstRemote: "a.txt"},
		{Op: operations.OpCopy, Src: "gdrive,chunk_size='8M':photos/", Dst: ":local:/dst/photos"},
		{Op: operations.OpCopy, Src: ":local:/data/music/", Dst: ":local:/dst/music"},
		{Op: operations.OpDeleteFile, Src: ":local:/x", SrcRemote: "d.txt"},
		{Op: operations.OpDeleteFile, Src: ":local:/y", SrcRemote: "d.txt"},
		{Op: operations.OpPurge, Src: ":local:/", SrcRemote: "old/dir"},
	}}
	match := stepMatcher(p, []operations.StepRecord{
		{SrcFs: "/data", DstFs: "/dst"},
		{SrcFs: "gdrive{AbCdE}:photos", DstFs: "/dst/photos"},
		{SrcFs: "/data/music", DstFs: "/dst/music"},
		{SrcFs: "/x"}, {SrcFs: "/y"}, {SrcFs: "/"},
	})
	for _, tc := range []struct {
		snap accounting.TransferSnapshot
		want int // -1 means none
	}{
		{accounting.TransferSnapshot{Name: "a.txt", SrcFs: "/data"}, 0},
		{accounting.TransferSnapshot{Name: "2024/p.jpg", SrcFs: "gdrive{AbCdE}:photos"}, 1},
		{accounting.TransferSnapshot{Name: "song.mp3", DstFs: "/dst/music"}, 2},
		{accounting.TransferSnapshot{Name: "d.txt", SrcFs: "/y"}, 4},
		{accounting.TransferSnapshot{Name: "d.txt"}, -1}, // two steps match it
		{accounting.TransferSnapshot{Name: "old/dir/f.txt", SrcFs: "/"}, 5},
		{accounting.TransferSnapshot{Name: "z", SrcFs: "/elsewhere"}, -1},
	} {
		got := match(tc.snap)
		if (got == nil && tc.want != -1) || (got != nil && *got != tc.want) {
			t.Errorf("%+v → %v, want %d", tc.snap, got, tc.want)
		}
	}
	// Every file belongs to the only step.
	one := operations.Plan{V: 1, Steps: []operations.Step{{Op: operations.OpPurge, Src: "/x", SrcRemote: "d"}}}
	if got := stepMatcher(one, operations.NewRecord(one).Steps())(accounting.TransferSnapshot{Name: "q"}); got == nil || *got != 0 {
		t.Errorf("single step → %v", got)
	}
	whole := operations.Plan{V: 1, Steps: []operations.Step{{Op: operations.OpSync, Src: "/a", Dst: "/b"}}}
	if stepMatcher(whole, operations.NewRecord(whole).Steps())(accounting.TransferSnapshot{Name: "q"}) != nil {
		t.Error("a sync has steps to tell apart")
	}
}

// The 500 transfers that ended last are kept, so a long transfer that started before the others
// isn't deleted at its end. Open transfers, and those marked for resume, are always kept.
func TestRetention(t *testing.T) {
	f := newFixture(t)
	f.seed("1-open00", 1, map[string]any{"state": "running", "ended_ms": nil})
	f.seed("2-resume", 2, map[string]any{"state": "interrupted", "resume": 1})
	f.seed("3-long", 3, map[string]any{"ended_ms": 100_000})
	for i := range keepEnded + 5 {
		f.seed(fmt.Sprintf("%d-e", 100+i), int64(100+i), nil)
	}
	f.exec(`INSERT INTO transfer_files (transfer_id, outcome, src_fs, name) VALUES ('100-e', 'transferred', '', 'x')`)
	f.s.retain(context.Background())
	var ended, files int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers WHERE ended_ms IS NOT NULL AND resume = 0`).Scan(&ended); err != nil {
		t.Fatal(err)
	}
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfer_files`).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if ended != keepEnded || files != 0 {
		t.Errorf("%d ended and %d files kept", ended, files)
	}
	for id, kept := range map[string]bool{
		"1-open00": true, "2-resume": true, "3-long": true, "106-e": true, "604-e": true, "105-e": false, "100-e": false,
	} {
		if _, err := f.s.get(context.Background(), id); errors.Is(err, ErrNotFound) == kept {
			t.Errorf("%s: kept %v, want %v", id, err == nil, kept)
		}
	}
}

// Paging through the ended transfers never repeats or skips a row, even with a cursor whose row
// is gone.
func TestEndedPaging(t *testing.T) {
	f := newFixture(t)
	f.seed("50-open", 50, map[string]any{"state": "running", "ended_ms": nil})
	for i := range 25 {
		created := int64(100 + i/2) // two rows per ms, so the id breaks the tie
		f.seed(fmt.Sprintf("%d-%02d", created, i), created, map[string]any{"seq": 100 + i, "ended_ms": 1000 + i})
	}
	ctx := context.Background()
	var seen []string
	q := EndedQuery{Limit: 10}
	for pages := 0; ; pages++ {
		page, err := f.s.Ended(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		for _, tr := range page.Items {
			seen = append(seen, tr.ID)
		}
		if !page.More {
			break
		}
		q.Before = page.Items[len(page.Items)-1].ID
		if pages > 5 {
			t.Fatal("paging does not end")
		}
	}
	var want []Transfer
	for i := range 25 {
		created := int64(100 + i/2)
		want = append(want, Transfer{ID: fmt.Sprintf("%d-%02d", created, i), CreatedAt: created})
	}
	sortNewest(want)
	var wantIDs []string
	for _, tr := range want {
		wantIDs = append(wantIDs, tr.ID)
	}
	if !slices.Equal(seen, wantIDs) {
		t.Fatalf("paged %v, want %v", seen, wantIDs)
	}
	// A cursor whose row is gone still continues from where that row was.
	f.exec(`DELETE FROM transfers WHERE id = '110-20'`)
	page, _ := f.s.Ended(ctx, EndedQuery{Before: "110-20", Limit: 2})
	if len(page.Items) != 2 || page.Items[0].ID != "109-19" {
		t.Errorf("before a gone row: %+v", page.Items)
	}
}

// A transfer's files are paged per outcome, newest first, with their total.
func TestFilesPaging(t *testing.T) {
	f := newFixture(t)
	f.seed("1-aaaaaa", 1, nil)
	var rows []fileRow
	for i := range 7 {
		rows = append(rows, fileRow{outcome: OutcomeTransferred, srcFs: "/s", name: fmt.Sprintf("f%d", i), completedMS: int64(i / 2)})
	}
	f.merge("1-aaaaaa", rows...)
	ctx := context.Background()
	var names []string
	q := FilesQuery{Outcome: OutcomeTransferred, Limit: 3}
	for {
		page, err := f.s.Files(ctx, "1-aaaaaa", q)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 7 {
			t.Errorf("total %d", page.Total)
		}
		for _, file := range page.Items {
			names = append(names, file.Name)
		}
		if !page.More {
			break
		}
		q.Before = page.Items[len(page.Items)-1].Cursor
	}
	if !slices.Equal(names, []string{"f6", "f5", "f4", "f3", "f2", "f1", "f0"}) {
		t.Errorf("names %v", names)
	}
	if _, err := f.s.Files(ctx, "1-aaaaaa", FilesQuery{Outcome: "nope"}); err == nil {
		t.Error("an unknown outcome read")
	}
}
