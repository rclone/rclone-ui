package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/accounting"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

// A folder is copied from the operation page's arguments. It is recorded from queued to
// completed with its totals and files, reported to the pages and the targets, and its stats group
// is deleted at the end.
func TestCopyFolder(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 10)
	writeFile(t, filepath.Join(src, "sub", "b.txt"), 20)
	started, err := f.s.Start(f.ctx, Spec{
		Form:   formOf(t, "copy", operations.CopyArgs{Sources: []string{src}, Destination: dst}),
		Origin: page,
		Preset: &operations.Form{Operation: operations.OperationCopy, Copy: &operations.CopyArgs{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.Seq != 1 {
		t.Errorf("seq = %d, want 1", started.Seq)
	}
	tr := f.wait(started.ID)

	if tr.State != StateCompleted || tr.Error != "" {
		t.Fatalf("state %s error %q, want completed", tr.State, tr.Error)
	}
	for _, name := range []string{"a.txt", "sub/b.txt"} {
		if _, err := os.Stat(filepath.Join(dst, filepath.Base(src), name)); err != nil {
			t.Errorf("%s not copied: %v", name, err)
		}
	}
	if tr.Stats == nil || tr.Stats.Transfers != 2 || tr.Stats.Bytes != 30 {
		t.Errorf("final stats %+v, want 2 files of 30 bytes", tr.Stats)
	}
	if tr.Origin != page {
		t.Errorf("origin %+v", tr.Origin)
	}
	if tr.StartedAt == nil || tr.EndedAt == nil {
		t.Errorf("started %v ended %v", tr.StartedAt, tr.EndedAt)
	}
	if !slices.Equal(tr.Sources, []string{src}) || tr.Destination != dst {
		t.Errorf("sources %v destination %q", tr.Sources, tr.Destination)
	}
	files, err := f.s.Files(context.Background(), started.ID, FilesQuery{Outcome: OutcomeTransferred})
	if err != nil {
		t.Fatal(err)
	}
	if files.Total != 2 || len(files.Items) != 2 {
		t.Fatalf("files %+v, want the 2 transferred", files)
	}
	for _, file := range files.Items {
		if file.Step == nil || *file.Step != 0 {
			t.Errorf("%s: input %v, want 0", file.Name, file.Step)
		}
	}
	if got := f.notes.events(started.Seq); !slices.Equal(got, []notifications.NotificationEvent{
		notifications.NotificationEventJobStarted, notifications.NotificationEventJobCompleted,
	}) {
		t.Errorf("notified %v, want started then completed", got)
	}
	f.settled()
	if got := f.toasts(); len(got) != 1 || got[0].EventID != string(notifications.NotificationEventJobCompleted) ||
		got[0].Title != "Copy finished" || got[0].Body != src+" → "+dst {
		t.Errorf("desktop notifications %+v, want Copy finished: %s → %s", got, src, dst)
	}
	var states []string
	for _, ev := range f.published(bus.TransfersChanged) {
		states = append(states, ev.Data.(bus.TransfersChangedData).State)
	}
	if !slices.Equal(states, []string{"running", "completed"}) {
		t.Errorf("transfers.changed states %v", states)
	}
	if slices.Contains(groups(t), groupOf(started.ID)) {
		t.Error("the stats group outlived the transfer")
	}
	// The stored request is the plan that it ran.
	var request string
	if err := f.db.R.QueryRow(`SELECT request FROM transfers WHERE id = ?`, started.ID).Scan(&request); err != nil {
		t.Fatal(err)
	}
	if p, err := operations.ParsePlan([]byte(request)); err != nil || len(p.Steps) != 1 || p.Steps[0].Op != operations.OpCopy {
		t.Errorf("stored %s: %v", request, err)
	}
}

func syncOf(src, dst string) *operations.Plan {
	return planOf(operations.Step{Op: operations.OpSync, Src: src, Dst: dst})
}

// A long copy (throttled per job) is stopped. It is claimed first, so the cancellation it ends
// with is recorded as stopped, never as a failure. The targets are told only that it started.
func TestStopLongCopy(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), memory()
	writeFile(t, filepath.Join(src, "big.bin"), 2<<20)
	args := operations.CopyArgs{
		Sources: []string{filepath.Join(src, "big.bin")}, Destination: dst,
		Options: groupsOf("config", `{"bwlimit_file":"10K"}`),
	}
	started, err := f.s.Start(f.ctx, Spec{Form: formOf(t, "copy", args), Origin: page})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.get(started.ID); got.State != StateRunning {
		t.Fatalf("state %s after the launch check, want running", got.State)
	}
	active, err := f.s.Active(context.Background())
	if err != nil || len(active) != 1 {
		t.Fatalf("active %v %v", active, err)
	}
	if err := f.s.Stop(f.ctx, started.ID); err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateStopped || tr.Error != "" || tr.Stats == nil {
		t.Fatalf("state %s error %q stats %v, want stopped with its totals", tr.State, tr.Error, tr.Stats)
	}
	if err := f.s.Stop(f.ctx, started.ID); !errors.Is(err, ErrNotRunning) {
		t.Errorf("second stop: %v, want ErrNotRunning", err)
	}
	if got := f.notes.events(started.Seq); !slices.Equal(got, []notifications.NotificationEvent{notifications.NotificationEventJobStarted}) {
		t.Errorf("notified %v", got)
	}
	if tr.Stats.Bytes >= 2<<20 {
		t.Errorf("%d bytes moved: the copy was not stopped", tr.Stats.Bytes)
	}
	f.settled()
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("a stop showed %+v on the desktop", got)
	}
}

// StopAll stops each open transfer and counts it. With nothing open, it stops nothing and
// reports no error.
func TestStopAll(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), memory()
	writeFile(t, filepath.Join(src, "big.bin"), 2<<20)
	args := operations.CopyArgs{
		Sources: []string{filepath.Join(src, "big.bin")}, Destination: dst,
		Options: groupsOf("config", `{"bwlimit_file":"10K"}`),
	}
	started, err := f.s.Start(f.ctx, Spec{Form: formOf(t, "copy", args), Origin: page})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := f.s.StopAll(f.ctx); err != nil || n != 1 {
		t.Fatalf("stopped %d: %v", n, err)
	}
	if tr := f.wait(started.ID); tr.State != StateStopped {
		t.Fatalf("state %s, want stopped", tr.State)
	}
	if n, err := f.s.StopAll(f.ctx); err != nil || n != 0 {
		t.Fatalf("with nothing open: stopped %d: %v", n, err)
	}
	f.settled()
}

// A dry run writes nothing, is recorded as a dry run, and tells the targets nothing. Its preset
// doesn't reopen as a dry run.
func TestDryRun(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 10)
	preset := formOf(t, "copy", json.RawMessage(`{"options":{"config":{"dry_run":true,"transfers":2}}}`))
	started, err := f.s.Start(f.ctx, Spec{
		Form:   formOf(t, "copy", operations.CopyArgs{Sources: []string{src}, Destination: dst}),
		DryRun: true,
		Preset: &preset,
		Origin: page,
	})
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateCompleted || !tr.IsDryRun {
		t.Fatalf("state %s dry %v", tr.State, tr.IsDryRun)
	}
	entries, _ := os.ReadDir(dst)
	if len(entries) != 0 {
		t.Errorf("a dry run wrote %v", entries)
	}
	if got := f.notes.events(started.Seq); len(got) != 0 {
		t.Errorf("a dry run notified %v", got)
	}
	f.settled()
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("a dry run showed %+v on the desktop", got)
	}
	d, err := f.s.Get(context.Background(), started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(mustJSON(t, d.Preset)); strings.Contains(got, "dry_run") || !strings.Contains(got, `"transfers":2`) {
		t.Errorf("preset %s", got)
	}
	// The page's own preset is left as it was.
	if _, ok := preset.Copy.Options.Config["dry_run"]; !ok {
		t.Error("the page's preset lost its dry run")
	}
}

// A request whose source is gone by the time it runs (because the plan was built earlier) ends
// within the launch check. Start returns rclone's error, and the row is failed, never started.
// The targets are told about the failure, but the desktop isn't, because the page shows Start's
// error.
func TestLaunchCheckRefusesMissingSource(t *testing.T) {
	f := newFixture(t)
	missing := filepath.Join(t.TempDir(), "missing")
	started, err := f.s.Start(f.ctx, Spec{
		Form: operations.Form{Operation: "copy"}, Sources: []string{missing}, Origin: page,
		Plan: planOf(operations.Step{Op: operations.OpCopy, Src: missing, Dst: t.TempDir()}),
	})
	if err == nil || !strings.Contains(err.Error(), "directory not found") {
		t.Fatalf("Start = %v, want the launch's directory not found", err)
	}
	if started.ID == "" {
		t.Fatal("a failed launch must be recorded")
	}
	tr := f.wait(started.ID)
	if tr.State != StateFailed || tr.Error != "1 of 1 operations failed" || tr.EndedAt == nil {
		t.Errorf("state %s error %q", tr.State, tr.Error)
	}
	if got := f.notes.events(started.Seq); !slices.Equal(got, []notifications.NotificationEvent{notifications.NotificationEventJobFailed}) {
		t.Errorf("notified %v, want failed alone", got)
	}
	// The targets get the step's own error, not how many steps failed.
	f.notes.mu.Lock()
	sent := f.notes.got[len(f.notes.got)-1].job.Error
	f.notes.mu.Unlock()
	if !strings.Contains(sent, "directory not found") {
		t.Errorf("the failure was sent as %q", sent)
	}
	f.settled()
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("a failure Start answered showed %+v on the desktop", got)
	}

	// With the page's arguments, rclone is asked first, so nothing is recorded.
	before, _ := f.s.Active(context.Background())
	_, err = f.s.Start(f.ctx, Spec{
		Form:   formOf(t, "copy", operations.CopyArgs{Sources: []string{missing}, Destination: t.TempDir()}),
		Origin: page,
	})
	if err == nil {
		t.Fatal("a missing source started")
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(before) != 0 {
		t.Errorf("%d rows, want only the launch's", n)
	}
}

// A plan that rclone can't run as it is (an option it refuses, or an operation it doesn't have)
// is refused before anything is recorded. So are a start without an origin, a form whose options
// rclone refuses, and a purge of a root.
func TestPlanRefused(t *testing.T) {
	f := newFixture(t)
	bad := syncOf(t.TempDir(), t.TempDir())
	bad.Config = operations.Options{"transfers": "many"}
	if s, err := f.s.Start(f.ctx, Spec{Form: operations.Form{Operation: "copy"}, Plan: planOf(operations.Step{Op: operations.OpDelete, Src: "/x"})}); err == nil || s.ID != "" {
		t.Errorf("a start without an origin: %+v %v", s, err)
	}
	if s, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "sync"}, Plan: bad}); err == nil || s.ID != "" || !strings.Contains(err.Error(), "transfers") {
		t.Errorf("a bad option: %+v %v", s, err)
	}
	if s, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "copy"}, Plan: planOf(operations.Step{Op: "format", Src: "/x"})}); err == nil || s.ID != "" {
		t.Errorf("an unknown step: %+v %v", s, err)
	}
	args := operations.CopyArgs{Sources: []string{t.TempDir()}, Destination: t.TempDir(),
		Options: groupsOf("filter", `{"files_from_zero": ["x"]}`)}
	if s, err := f.s.Start(f.ctx, Spec{Origin: page, Form: formOf(t, "copy", args)}); err == nil || s.ID != "" ||
		!strings.Contains(err.Error(), "files_from_zero") {
		t.Errorf("an unknown filter: %+v %v", s, err)
	}
	root := mustJSON(t, operations.PurgeArgs{Sources: []string{":memory:"}})
	if s, err := f.s.Start(f.ctx, Spec{Origin: page, Form: formOf(t, "purge", root)}); err == nil || s.ID != "" ||
		!strings.Contains(err.Error(), "is the root of a remote") || !errs.Is(err) {
		t.Errorf("a purge of a root: %+v %v", s, err)
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers`).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d rows recorded", n)
	}
}

// A plan with one failing step ends failed ("1 of 2"). It keeps its output and its list of
// files: the files moved, the one that failed (matched to its folder's step), and what can be
// retried.
func TestPlanWithFailingStep(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "ok.txt"), 5)
	folder := filepath.Join(src, "photos")
	writeFile(t, filepath.Join(folder, "a.jpg"), 7)
	writeFile(t, filepath.Join(folder, "blocked.jpg"), 9)
	// One file fails on a folder that has its name in the destination, which rclone doesn't
	// write over. That is so on every OS, unlike a file made unreadable by its mode.
	inTheWay := filepath.Join(dst, "photos", "blocked.jpg")
	if err := os.MkdirAll(inTheWay, 0o700); err != nil {
		t.Fatal(err)
	}

	started, err := f.s.Start(f.ctx, Spec{
		Form: formOf(t, "copy", operations.CopyArgs{
			Sources: []string{filepath.Join(src, "ok.txt"), folder}, Destination: dst,
		}),
		Origin: page,
	})
	if err != nil {
		t.Fatalf("a partly failed batch is no failed launch: %v", err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateFailed || tr.Error != "1 of 2 operations failed" {
		t.Fatalf("state %s error %q", tr.State, tr.Error)
	}
	var output string
	if err := f.db.R.QueryRow(`SELECT job_output FROM transfers WHERE id = ?`, started.ID).Scan(&output); err != nil {
		t.Fatal(err)
	}
	if out, ok := parseOutcome([]byte(output)); !ok || len(out.Errors) != 2 || out.Errors[0] != "" || out.Errors[1] == "" {
		t.Errorf("job output %s", output)
	}
	ctx := context.Background()
	moved, _ := f.s.Files(ctx, started.ID, FilesQuery{Outcome: OutcomeTransferred})
	var names []string
	for _, file := range moved.Items {
		names = append(names, filepath.Base(file.Name))
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"a.jpg", "ok.txt"}) {
		t.Errorf("transferred %v", names)
	}
	failed, _ := f.s.Files(ctx, started.ID, FilesQuery{Outcome: OutcomeFailed})
	if failed.Total != 1 || failed.Items[0].Name != "blocked.jpg" || failed.Items[0].Step == nil || *failed.Items[0].Step != 1 {
		t.Fatalf("failed %+v", failed.Items)
	}
	r, err := f.s.Retryable(ctx, started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Items) != 1 || r.Items[0].Kind != "file" || r.Items[0].Label != "blocked.jpg" {
		t.Fatalf("retryable %+v", r.Items)
	}
	d, err := f.s.Get(ctx, started.ID)
	if err != nil || d.Retryable != 1 {
		t.Errorf("detail retryable %d %v", d.Retryable, err)
	}
	// The files that a page which started it reads.
	tracked, err := f.s.Tracked(ctx, []string{"gone", started.ID, started.ID})
	if err != nil || len(tracked) != 1 || tracked[0].ID != started.ID || len(tracked[0].Files) != 3 {
		t.Errorf("tracked %+v %v", tracked, err)
	}

	// The retry starts the selected file as one new transfer with the original's settings.
	if err := os.Remove(inTheWay); err != nil {
		t.Fatal(err)
	}
	again, err := f.s.Retry(f.ctx, started.ID, [][2]string{r.Items[0].Key})
	if err != nil {
		t.Fatal(err)
	}
	rt := f.wait(again.ID)
	if rt.State != StateCompleted || rt.RetryOf != started.ID || rt.Origin != page {
		t.Errorf("retry %s retry of %q origin %+v", rt.State, rt.RetryOf, rt.Origin)
	}
	if info, err := os.Stat(inTheWay); err != nil || info.IsDir() {
		t.Errorf("the retried file is not there: %v", err)
	}
	d, _ = f.s.Get(ctx, again.ID)
	if d.RetryOf == nil || d.RetryOf.Seq != started.Seq {
		t.Errorf("retry's retryOf %+v", d.RetryOf)
	}
	d, _ = f.s.Get(ctx, started.ID)
	if len(d.Retries) != 1 || d.Retries[0].ID != again.ID {
		t.Errorf("original's retries %+v", d.Retries)
	}
	if _, err := f.s.Retry(f.ctx, started.ID, [][2]string{{"nowhere", "x"}}); !errors.Is(err, ErrNoRetry) {
		t.Errorf("an unknown key: %v", err)
	}
}

// The ticker reads the transfer's group through its pointer, because a call by the group's name
// would create it again after it was deleted. The progress is the transfer's own, and the group
// is gone after the end.
func TestTickerReadsItsGroupAndDeletesIt(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), memory()
	for i := range 3 {
		writeFile(t, filepath.Join(src, string(rune('a'+i))+".bin"), 30<<10)
	}
	args := operations.CopyArgs{
		Sources: []string{src}, Destination: dst,
		Options: groupsOf("config", `{"bwlimit_file":"20K"}`),
	}
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: formOf(t, "copy", args)})
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateCompleted {
		t.Fatalf("state %s %q", tr.State, tr.Error)
	}
	if len(f.published(bus.TransfersProgress)) == 0 {
		t.Fatal("no progress while it ran")
	}
	time.Sleep(1500 * time.Millisecond) // a tick after the end
	if slices.Contains(groups(t), groupOf(started.ID)) {
		t.Error("the group exists after the end")
	}
	var progress bus.TransferProgress
	for _, ev := range f.published(bus.TransfersProgress) {
		if p, ok := ev.Data.(bus.TransfersProgressData).Items[started.ID]; ok {
			progress = p
		}
	}
	if progress.Seq != started.Seq || progress.TotalBytes == 0 {
		t.Errorf("last progress %+v", progress)
	}
}

// A shutdown claims the running transfers as interrupted and waits for the end handlers. A
// restart with resume marks the transfers started from the pages, but not a bisync, as the busy
// check said it would. Nothing starts after the shutdown.
func TestShutdownAndResume(t *testing.T) {
	for _, tc := range []struct {
		name     string
		resume   bool
		wantPage bool
	}{
		{"restart with resume", true, true},
		{"a quit", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			f := newFixture(t)
			src := t.TempDir()
			writeFile(t, filepath.Join(src, "big.bin"), 1<<20)
			slow := func() *operations.Plan {
				p := planOf(operations.Step{Op: operations.OpCopyFile, Src: src, SrcRemote: "big.bin", Dst: memory(), DstRemote: "big.bin"})
				p.Config = operations.Options{"bwlimit_file": "10K"}
				return p
			}
			copied, err := f.s.Start(f.ctx, Spec{Form: operations.Form{Operation: "copy"}, Plan: slow(), Origin: page})
			if err != nil {
				t.Fatal(err)
			}
			step, err := f.s.Start(f.ctx, Spec{Form: operations.Form{Operation: "bisync"}, Plan: slow(), Origin: page})
			if err != nil {
				t.Fatal(err)
			}
			if !Resumable(f.get(copied.ID)) || Resumable(f.get(step.ID)) {
				t.Errorf("resumable: the page's %v, the bisync's %v", Resumable(f.get(copied.ID)), Resumable(f.get(step.ID)))
			}

			f.s.Shutdown(context.Background(), tc.resume)
			for id, want := range map[string]bool{copied.ID: tc.wantPage, step.ID: false} {
				tr := f.get(id)
				if tr.State != StateInterrupted || tr.EndedAt == nil || tr.Stats == nil {
					t.Errorf("%s: state %s ended %v: the end handler did not run in the wait", id, tr.State, tr.EndedAt)
				}
				if tr.Resume != want {
					t.Errorf("%s: resume %v, want %v", id, tr.Resume, want)
				}
			}
			if _, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "sync"}, Plan: syncOf(src, t.TempDir())}); !errors.Is(err, ErrShuttingDown) {
				t.Errorf("a start after the shutdown: %v", err)
			}
		})
	}
}

// After a restart for an update, the marked transfer starts again as a retry of itself, with its
// plan and origin. The flag is cleared first. Rows left open are interrupted and get the previous
// process's last log time. A transfer that a newer build recorded is history and isn't started
// again.
func TestRecover(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 3)
	request := string(mustJSON(t, syncOf(src, dst)))
	f.seed("1000-aaaaaa", 1000, map[string]any{"state": "running", "ended_ms": nil})
	f.seed("1001-bbbbbb", 1001, map[string]any{"state": "queued", "ended_ms": nil})
	f.seed("1002-cccccc", 1002, map[string]any{"state": "stopped", "ended_ms": nil})
	f.seed("1003-dddddd", 1003, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "sync", "request": request,
		"origin_kind": "commander", "args": `{"source":"x"}`,
		"preset": `{"operation":"sync","args":{}}`,
	})
	f.seed("1004-eeeeee", 1004, map[string]any{"state": "interrupted"})
	f.seed("1005-ffffff", 1005, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "sync", "origin_kind": "commander",
		"request": `{"v":99,"steps":[{"op":"sync","src":"/a","dst":"/b"}]}`,
	})

	if err := f.s.Recover(f.ctx, 5000); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]State{
		"1000-aaaaaa": StateInterrupted, "1001-bbbbbb": StateInterrupted, "1002-cccccc": StateStopped,
	} {
		tr := f.get(id)
		if tr.State != want || tr.EndedAt == nil || *tr.EndedAt != 5000 {
			t.Errorf("%s: %s ended %v, want %s at 5000", id, tr.State, tr.EndedAt, want)
		}
	}
	if f.get("1003-dddddd").Resume {
		t.Error("the resume flag stayed")
	}
	var again string
	if err := f.db.R.QueryRow(`SELECT id FROM transfers WHERE retry_of = '1003-dddddd'`).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if again == "" {
		t.Fatal("the marked transfer was not started again")
	}
	tr := f.wait(again)
	if tr.State != StateCompleted || tr.Origin.Kind != OriginCommander || tr.Operation != "sync" {
		t.Errorf("resumed %+v", tr)
	}
	if _, err := os.Stat(filepath.Join(dst, "a.txt")); err != nil {
		t.Errorf("the resumed sync did not run: %v", err)
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers WHERE retry_of IN ('1004-eeeeee', '1005-ffffff')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Error("an unmarked interrupted transfer, or an old one, came back")
	}
	if tr := f.get("1005-ffffff"); tr.State != StateFailed ||
		tr.Error != "Couldn't start again after the update: the transfer's plan is of version 99; this version of the app runs version 1" {
		t.Errorf("a newer build's: %s %q", tr.State, tr.Error)
	}
	// Recover again, as after a crash right afterwards. Nothing comes back twice.
	if err := f.s.Recover(f.ctx, 6000); err != nil {
		t.Fatal(err)
	}
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers WHERE retry_of = '1003-dddddd'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("%d resumes, want 1", n)
	}
}

// A batch that was running when the app restarted for an update comes back with only the steps
// that had not succeeded. A move that was done is not run again, because it would fail on the
// file it had moved. A batch whose end was never written comes back whole, and a batch whose
// steps all succeeded doesn't come back.
func TestRecoverSkipsWhatSucceeded(t *testing.T) {
	f := newFixture(t)
	// The folders are written with `/`, as a plan's steps and the sources read from them are.
	src, dst := filepath.ToSlash(t.TempDir()), filepath.ToSlash(t.TempDir())
	writeFile(t, filepath.Join(dst, "a.txt"), 3) // moved before the restart
	writeFile(t, filepath.Join(src, "b.txt"), 3)
	writeFile(t, filepath.Join(src, "c.txt"), 3)
	move := func(name string) operations.Step {
		return operations.Step{Op: operations.OpMoveFile, Src: src, SrcRemote: name, Dst: dst, DstRemote: name}
	}
	request := string(mustJSON(t, planOf(move("a.txt"), move("b.txt"), move("c.txt"))))
	f.seed("2000-aaaaaa", 2000, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "move", "origin_kind": "commander", "request": request,
		"sources":    string(mustJSON(t, []string{src + "/a.txt", src + "/b.txt", src + "/c.txt"})),
		"job_output": `{"v":1,"errors":["","context canceled","context canceled"]}`,
	})
	f.seed("2001-bbbbbb", 2001, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "move", "origin_kind": "commander", "request": request,
		"job_output": `{"v":1,"errors":["","",""]}`,
	})
	if err := f.s.Recover(f.ctx, 5000); err != nil {
		t.Fatal(err)
	}
	var again, resumedRequest string
	if err := f.db.R.QueryRow(`SELECT id, request FROM transfers WHERE retry_of = '2000-aaaaaa'`).Scan(&again, &resumedRequest); err != nil {
		t.Fatal(err)
	}
	tr := f.wait(again)
	if tr.State != StateCompleted || !slices.Equal(tr.Sources, []string{src + "/b.txt", src + "/c.txt"}) {
		t.Errorf("resumed %+v", tr)
	}
	plan, err := operations.ParsePlan([]byte(resumedRequest))
	if err != nil || len(plan.Steps) != 2 || plan.Steps[0].SrcRemote != "b.txt" {
		t.Errorf("resumed plan %+v (%v)", plan, err)
	}
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := os.Stat(filepath.Join(dst, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers WHERE retry_of = '2001-bbbbbb'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("a batch with nothing left came back: %d (%v)", n, err)
	}

	// With no end output, every step is run again.
	if left := resumeOf(*planOf(move("a.txt"), move("b.txt")), nil); len(left.Steps) != 2 {
		t.Errorf("without an end: %+v", left.Steps)
	}
	if left := resumeOf(*planOf(move("a.txt"), move("b.txt")), []byte(`{"v":1,"errors":[""]}`)); len(left.Steps) != 2 {
		t.Errorf("with an end of another plan: %+v", left.Steps)
	}
}

// Options.Ended runs before transfers.changed reports the end. The Browser lists a folder
// again as soon as it hears, so the listing cache must be dropped by then (browse.TransferEnded).
func TestTheEndCallbacksRunBeforeTheEndIsSaid(t *testing.T) {
	var sub *bus.Sub
	heardFirst := make(chan bool, 1)
	f := newFixture(t, func(o *Options) {
		sub = o.Bus.Subscribe()
		o.Ended = func(tr Transfer) { heardFirst <- heardEnd(sub, tr) }
	})
	t.Cleanup(sub.Close)
	src := t.TempDir()

	writeFile(t, filepath.Join(src, "a.txt"), 10)
	started, err := f.s.Start(f.ctx, Spec{
		Form:   formOf(t, "copy", operations.CopyArgs{Sources: []string{src}, Destination: t.TempDir()}),
		Origin: page,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.wait(started.ID)
	if <-heardFirst {
		t.Error("transfers.changed said the end before Options.Ended ran")
	}
}

// heardEnd drains sub and reports whether it held transfers.changed for tr's end.
func heardEnd(sub *bus.Sub, tr Transfer) bool {
	heard := false
	for {
		select {
		case ev := <-sub.C:
			if d, ok := ev.Data.(bus.TransfersChangedData); ok && d.ID == tr.ID && d.State == string(tr.State) {
				heard = true
			}
		default:
			return heard
		}
	}
}

// The end is written once. A claim made between the job's end and the UPDATE keeps its state,
// the end's totals and output are still written, and a second end writes nothing.
func TestEndsOnce(t *testing.T) {
	release := make(chan struct{})
	f := newFixture(t, func(o *Options) {
		o.Ended = func(tr Transfer) {
			if tr.State == StateStopped {
				close(release)
			}
		}
	})
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "big.bin"), 1<<20)
	slow := planOf(operations.Step{Op: operations.OpCopyFile, Src: src, SrcRemote: "big.bin", Dst: memory(), DstRemote: "big.bin"})
	slow.Config = operations.Options{"bwlimit_file": "10K"}
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "copy"}, Plan: slow})
	if err != nil {
		t.Fatal(err)
	}
	f.s.mu.Lock()
	rn := f.s.running[started.ID]
	f.s.mu.Unlock()
	// The claim lands after rclone ended the job and before the end is written. The job is
	// cancelled directly, so only the claim records it as stopped.
	f.exec(`UPDATE transfers SET state = 'stopped' WHERE id = ?`, started.ID)
	rn.job.Stop()
	<-release
	// The end callbacks run before transfers.changed says the end, so wait for it before
	// counting the events.
	f.wait(started.ID)
	tr := f.get(started.ID)
	if tr.State != StateStopped || tr.Error != "" || tr.Stats == nil {
		t.Fatalf("state %s error %q stats %v", tr.State, tr.Error, tr.Stats)
	}
	var output *string
	if err := f.db.R.QueryRow(`SELECT job_output FROM transfers WHERE id = ?`, started.ID).Scan(&output); err != nil {
		t.Fatal(err)
	}
	if output == nil {
		t.Error("the end snapshot's output was not written")
	}
	ended := *tr.EndedAt
	// A second end (the handler running again) writes and reports nothing.
	rn2 := *rn
	rn2.ended, rn2.launched = make(chan struct{}), make(chan struct{})
	close(rn2.launched)
	changes := len(f.published(bus.TransfersChanged))
	f.s.ends.Add(1)
	f.s.finish(&rn2)
	if got := f.get(started.ID); *got.EndedAt != ended || got.State != StateStopped {
		t.Errorf("a second end rewrote it: %+v", got)
	}
	if len(f.published(bus.TransfersChanged)) != changes {
		t.Error("a second end was said")
	}
}

// held serves files over HTTP for an :http remote, and holds every request until release. A
// transfer, or a start's plan, waits on it in the middle of a request.
type held struct {
	srv     *httptest.Server
	asked   chan struct{} // a request arrived
	release chan struct{}
}

func newHeld(t *testing.T, files map[string]string) *held {
	t.Helper()
	h := &held{asked: make(chan struct{}, 1), release: make(chan struct{})}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case h.asked <- struct{}{}:
		default:
		}
		select {
		case <-h.release:
		case <-r.Context().Done():
			return
		}
		body, ok := files[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, r.URL.Path, time.Unix(1700000000, 0), strings.NewReader(body))
	}))
	t.Cleanup(h.srv.Close)
	return h
}

// remote returns the served root as an rclone path.
func (h *held) remote() string { return fmt.Sprintf(":http,url='%s/':", h.srv.URL) }

func (h *held) waitAsked(t *testing.T) {
	t.Helper()
	select {
	case <-h.asked:
	case <-time.After(10 * time.Second):
		t.Fatal("the remote was never asked")
	}
}

// A start whose plan waits on a remote holds nothing that a shutdown waits for. The shutdown
// ends at once, a start during it is refused at once, and the start being prepared records
// nothing.
func TestShutdownDoesNotWaitForAStartBeingPrepared(t *testing.T) {
	f := newFixture(t)
	h := newHeld(t, nil)
	t.Cleanup(func() { close(h.release) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	args := mustJSON(t, operations.CopyArgs{Sources: []string{h.remote() + "dir"}, Destination: t.TempDir()})
	done := make(chan error, 1)
	go func() {
		_, err := f.s.Start(ctx, Spec{Origin: page, Form: formOf(t, "copy", args)})
		done <- err
	}()
	h.waitAsked(t)

	shut := make(chan struct{})
	go func() {
		f.s.Shutdown(context.Background(), false)
		close(shut)
	}()
	select {
	case <-shut:
	case <-time.After(5 * time.Second):
		t.Fatal("the shutdown waited for a start's remote")
	}
	refused := make(chan error, 1)
	go func() {
		_, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "sync"}, Plan: syncOf(t.TempDir(), t.TempDir())})
		refused <- err
	}()
	select {
	case err := <-refused:
		if !errors.Is(err, ErrShuttingDown) {
			t.Errorf("a start during the shutdown: %v, want ErrShuttingDown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a start during the shutdown waited")
	}

	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("the start being prepared started after the shutdown")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the start being prepared never ended")
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers`).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d transfers recorded (%v), want none", n, err)
	}
}

// A stop that reaches a job whose plan has returned on its own, before its end is written, is
// refused. A stop claim that lands at that point doesn't hold either. The transfer ends as it
// really did, and the targets and the desktop are told so.
func TestStopAfterTheJobEndedDoesNotRelabelIt(t *testing.T) {
	f := newFixture(t)
	h := newHeld(t, map[string]string{"a.txt": "abc"})
	plan := planOf(operations.Step{Op: operations.OpCopyFile, Src: h.remote(), SrcRemote: "a.txt", Dst: t.TempDir(), DstRemote: "a.txt"})
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "copy"}, Plan: plan})
	if err != nil {
		t.Fatal(err)
	}
	f.s.mu.Lock()
	rn := f.s.running[started.ID]
	f.s.mu.Unlock()
	if rn == nil {
		t.Fatal("the transfer is not running")
	}

	// Hold the writer, so the end waits for it once the job is done.
	tx, err := f.db.W.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	close(h.release)
	testutil.Eventually(t, 10*time.Second, "the plan's end", rn.ranOutAlone)

	stopped := make(chan error, 1)
	go func() { stopped <- f.s.Stop(f.ctx, started.ID) }()
	select {
	case err := <-stopped:
		if !errors.Is(err, ErrNotRunning) {
			t.Errorf("a stop after the job ended: %v, want ErrNotRunning", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stop of an ended job waited to claim it")
	}
	// A claim that was written before the check (the plan returned meanwhile).
	if _, err := tx.Exec(`UPDATE transfers SET state = 'stopped' WHERE id = ?`, started.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	tr := f.wait(started.ID)
	if tr.State != StateCompleted || tr.Error != "" {
		t.Fatalf("state %s error %q, want completed", tr.State, tr.Error)
	}
	if got := f.notes.events(started.Seq); !slices.Contains(got, notifications.NotificationEventJobCompleted) {
		t.Errorf("notified %v, want completed", got)
	}
	f.settled()
	if got := f.toasts(); len(got) != 1 || got[0].Title != "Copy finished" ||
		got[0].Route != "/history?id="+started.ID || !got[0].ToastOnly {
		t.Errorf("desktop notifications %+v", got)
	}
}

// An end that can't be written with its files (a full disk) is tried again, then written on its
// own. The transfer ends with its state instead of staying running until the next start.
func TestEndWrittenAloneWhenItsFilesCannotBe(t *testing.T) {
	f := newFixture(t)
	f.s.endWaits = []time.Duration{time.Millisecond, time.Millisecond}
	f.exec(`CREATE TRIGGER no_room BEFORE UPDATE OF final_stats ON transfers
		WHEN NEW.final_stats IS NOT NULL BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 10)
	started, err := f.s.Start(f.ctx, Spec{
		Form:   formOf(t, "copy", operations.CopyArgs{Sources: []string{src}, Destination: t.TempDir()}),
		Origin: page,
	})
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateCompleted || tr.EndedAt == nil || tr.Stats != nil {
		t.Fatalf("state %s ended %v stats %+v, want completed without its totals", tr.State, tr.EndedAt, tr.Stats)
	}
	if active, err := f.s.Active(context.Background()); err != nil || len(active) != 0 {
		t.Errorf("still active: %v %v", active, err)
	}
	if got := f.notes.events(started.Seq); !slices.Contains(got, notifications.NotificationEventJobCompleted) {
		t.Errorf("notified %v, want completed", got)
	}
}

// retryEnd tries writing an end again after each of its waits, and stops at the first success.
func TestRetryEnd(t *testing.T) {
	s := &Service{log: slog.New(slog.DiscardHandler), endWaits: []time.Duration{time.Millisecond, time.Millisecond}}
	failing := errors.New("busy")
	tries := 0
	if err := s.retryEnd(context.Background(), func() error {
		tries++
		if tries < 3 {
			return failing
		}
		return nil
	}); err != nil || tries != 3 {
		t.Errorf("%d tries, %v: want a success at the third", tries, err)
	}
	tries = 0
	if err := s.retryEnd(context.Background(), func() error { tries++; return failing }); err != failing || tries != 3 {
		t.Errorf("%d tries, %v: want the error after three", tries, err)
	}
}

// When a start can't record that its job is running, it stops the job and returns the reason.
// The job doesn't run without a record, no change without a state is published, and the
// transfer still ends.
func TestStartStopsAJobItCannotMarkRunning(t *testing.T) {
	f := newFixture(t)
	f.exec(`CREATE TRIGGER no_start BEFORE UPDATE OF started_ms ON transfers
		BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "big.bin"), 1<<20)
	slow := planOf(operations.Step{Op: operations.OpCopyFile, Src: src, SrcRemote: "big.bin", Dst: memory(), DstRemote: "big.bin"})
	slow.Config = operations.Options{"bwlimit_file": "10K"}
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "copy"}, Plan: slow})
	if err == nil || !strings.Contains(err.Error(), "recording the transfer's start") || started.ID == "" {
		t.Fatalf("Start = %+v, %v", started, err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateFailed || tr.Stats == nil || tr.Stats.Bytes >= 1<<20 {
		t.Errorf("state %s stats %+v, want its job stopped", tr.State, tr.Stats)
	}
	for _, ev := range f.published(bus.TransfersChanged) {
		if ev.Data.(bus.TransfersChangedData).State == "" {
			t.Error("a change without a state was published")
		}
	}
}

// The desktop notification for an end says, in plain words, what the transfer was and how it
// ended. Secrets in its paths and error are hidden.
func TestToastOf(t *testing.T) {
	for _, tc := range []struct {
		name        string
		t           Transfer
		failed      int
		title, body string
	}{
		{"a copy", Transfer{Operation: "copy", State: StateCompleted, Sources: []string{"/Users/a/Photos"}, Destination: "gdrive:Photos"}, 0,
			"Copy finished", "/Users/a/Photos → gdrive:Photos"},
		{"a delete", Transfer{Operation: "delete", State: StateCompleted, Sources: []string{"gdrive:Old"}}, 0,
			"Delete finished", "gdrive:Old"},
		{"sources", Transfer{Operation: "move", State: StateCompleted, Sources: []string{"/a", "/b", "/c", "/d"}, Destination: "/e"}, 0,
			"Move finished", "/a, /b and 2 more → /e"},
		{"files failed", Transfer{Operation: "sync", State: StateFailed, Sources: []string{"/p"}, Destination: "gdrive:Photos", Error: "12 errors"}, 12,
			"Sync failed", "12 files couldn't be copied to gdrive:Photos"},
		{"one file", Transfer{Operation: "move", State: StateFailed, Sources: []string{"/p"}, Destination: "/q"}, 1,
			"Move failed", "1 file couldn't be moved to /q"},
		{"the ledger's cap", Transfer{Operation: "copy", State: StateFailed, Sources: []string{"/p"}, Destination: "/q"}, maxFailed,
			"Copy failed", "At least 1000 files couldn't be copied to /q"},
		{"a delete's files", Transfer{Operation: "delete", State: StateFailed, Sources: []string{"gdrive:Old"}}, 3,
			"Delete failed", "3 files couldn't be deleted from gdrive:Old"},
		{"no file", Transfer{Operation: "copy", State: StateFailed, Sources: []string{"/gone"}, Destination: "/q", Error: "directory not found"}, 0,
			"Copy failed", "/gone → /q — directory not found"},
		{"secrets", Transfer{Operation: "copy", State: StateFailed, Sources: []string{":s3,secret_access_key=hush:b"},
			Destination: "https://u:pw@example.com/x", Error: "at :s3,secret_access_key=hush:b"}, 0,
			"Copy failed", ":s3,secret_access_key=***:b → https://u:***@example.com/x — at :s3,secret_access_key=***:b"},
	} {
		if title, body := toastOf(tc.t, tc.failed); title != tc.title || body != tc.body {
			t.Errorf("%s: %q / %q, want %q / %q", tc.name, title, body, tc.title, tc.body)
		}
	}
}

// A restart for an update marked a transfer whose plan this build refuses (an option that rclone
// dropped). The transfer fails with the reason, instead of staying interrupted with no
// explanation, and the desktop is told. Its retry page explains why it can't run instead of
// offering items that would fail, and Retry refuses it the same way.
func TestRecoverSaysARefusedResume(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seed("3000-aaaaaa", 3000, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "copy", "origin_kind": "page",
		"sources": `["/a"]`, "destination": "/b",
		"request":    `{"v":1,"steps":[{"op":"copy","src":"/a","dst":"/b"}],"config":{"no_such_option":"x"}}`,
		"job_output": `{"v":1,"errors":["context canceled"]}`,
	})
	if err := f.s.Recover(ctx, 5000); err != nil {
		t.Fatal(err)
	}
	why := "Couldn't start again after the update: the transfer's plan: ‘no_such_option’ is not an rclone option"
	if tr := f.get("3000-aaaaaa"); tr.State != StateFailed || tr.Error != why || tr.Resume {
		t.Fatalf("%s %q resume %v, want failed with why", tr.State, tr.Error, tr.Resume)
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfers WHERE retry_of = '3000-aaaaaa'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d started (%v)", n, err)
	}

	testutil.Eventually(t, 5*time.Second, "the desktop told", func() bool { return len(f.toasts()) > 0 })
	want := bus.NotifyOSData{
		EventID: string(notifications.NotificationEventJobFailed), Title: "Copy failed",
		Body: "/a → /b — " + why, Route: "/history?id=3000-aaaaaa", ToastOnly: true,
	}
	if got := f.toasts(); len(got) != 1 || got[0] != want {
		t.Errorf("desktop notifications %+v, want %+v", got, want)
	}

	r, err := f.s.Retryable(ctx, "3000-aaaaaa")
	if err != nil || len(r.Items) != 0 || r.Refused != "Copy can't run: ‘no_such_option’ is not an rclone option" {
		t.Errorf("retryable %+v %v", r, err)
	}
	if d, err := f.s.Get(ctx, "3000-aaaaaa"); err != nil || d.Retryable != 0 {
		t.Errorf("detail retryable %d %v", d.Retryable, err)
	}
	if s, err := f.s.Retry(ctx, "3000-aaaaaa", nil); err == nil || s.ID != "" {
		t.Errorf("a retry of it started: %+v %v", s, err)
	}
}

// A resume that starts and fails within its launch check (its source was removed meanwhile) is
// shown on the desktop, because no page asked for it and so no page shows Start's error.
func TestRecoverSaysAResumeThatFailsAtOnce(t *testing.T) {
	f := newFixture(t)
	missing := filepath.Join(t.TempDir(), "missing")
	request := mustJSON(t, planOf(operations.Step{Op: operations.OpCopy, Src: missing, Dst: t.TempDir()}))
	f.seed("3000-aaaaaa", 3000, map[string]any{
		"state": "interrupted", "resume": 1, "operation": "copy", "origin_kind": "page",
		"sources": mustJSON(t, []string{missing}), "destination": "/b", "request": request,
	})
	if err := f.s.Recover(context.Background(), 5000); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := f.db.R.QueryRow(`SELECT id FROM transfers WHERE retry_of = '3000-aaaaaa'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	// Start returned once its end was written.
	if tr := f.get(id); tr.State != StateFailed {
		t.Fatalf("the resume %s, want failed", tr.State)
	}

	testutil.Eventually(t, 5*time.Second, "the desktop told", func() bool { return len(f.toasts()) > 0 })
	if got := f.toasts(); len(got) != 1 || got[0].Title != "Copy failed" || got[0].Route != "/history?id="+id || !got[0].ToastOnly {
		t.Errorf("desktop notifications %+v", got)
	}
}

// A stop that claims a transfer after its row is inserted but before its job is tracked doesn't
// stop anything itself. The start finds the claim when it marks the job running, and stops the
// job. The transfer ends stopped, its job has done almost nothing, and no failure is recorded
// or reported.
func TestStopBeforeTheJobIsTracked(t *testing.T) {
	f := newFixture(t)
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "big.bin"), 1<<20)
	slow := planOf(operations.Step{Op: operations.OpCopyFile, Src: src, SrcRemote: "big.bin", Dst: memory(), DstRemote: "big.bin"})
	slow.Config = operations.Options{"bwlimit_file": "10K"}
	stopped := make(chan error, 1)
	f.s.inserted = func(id string) {
		f.s.mu.Lock()
		tracked := f.s.running[id] != nil
		f.s.mu.Unlock()
		if tracked {
			t.Error("the job is tracked already")
		}
		stopped <- f.s.Stop(f.ctx, id)
	}
	started, err := f.s.Start(f.ctx, Spec{Origin: page, Form: operations.Form{Operation: "copy"}, Plan: slow})
	if err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; err != nil {
		t.Fatalf("the stop: %v", err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateStopped || tr.Error != "" || tr.Stats == nil || tr.Stats.Bytes >= 1<<20 {
		t.Fatalf("state %s error %q stats %+v, want stopped early", tr.State, tr.Error, tr.Stats)
	}
	if got := f.notes.events(started.Seq); slices.Contains(got, notifications.NotificationEventJobFailed) ||
		slices.Contains(got, notifications.NotificationEventJobCompleted) {
		t.Errorf("notified %v", got)
	}
	f.settled()
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("desktop notifications %+v", got)
	}
}

// A start is refused after its row was inserted (rclone wouldn't start the job), and its end
// can't be written either. The end is tried again, then the row is left as it is. Nothing is
// reported for an end that isn't recorded, the stats group is deleted, and Recover ends the
// transfer at the next start.
func TestRefusalWhoseWriteFails(t *testing.T) {
	f := newFixture(t)
	f.s.endWaits = []time.Duration{time.Millisecond, time.Millisecond}
	ctx := context.Background()
	rw := row{
		id: newID(time.Now()), operation: "delete", sources: []string{"/a"}, origin: page,
		plan: *planOf(operations.Step{Op: operations.OpDelete, Src: "/a"}),
	}
	seq, err := f.s.insert(ctx, rw)
	if err != nil {
		t.Fatal(err)
	}
	group := groupOf(rw.id)
	accounting.StatsGroup(ctx, group) // as Start makes it before the job
	f.exec(`CREATE TRIGGER no_end BEFORE UPDATE OF ended_ms ON transfers
		BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
	changes := len(f.published(bus.TransfersChanged))

	f.s.refused(ctx, rw, seq, errors.New("the job could not start"))
	if tr := f.get(rw.id); tr.State != StateQueued || tr.EndedAt != nil {
		t.Errorf("state %s ended %v, want it as it was", tr.State, tr.EndedAt)
	}
	if slices.Contains(groups(t), group) {
		t.Error("its stats group stayed")
	}
	f.settled()
	if len(f.published(bus.TransfersChanged)) != changes || len(f.notes.events(seq)) != 0 || len(f.toasts()) != 0 {
		t.Errorf("an end that isn't recorded was said: %v", f.notes.events(seq))
	}

	f.exec(`DROP TRIGGER no_end`)
	if err := f.s.Recover(ctx, 5000); err != nil {
		t.Fatal(err)
	}
	if tr := f.get(rw.id); tr.State != StateInterrupted || tr.EndedAt == nil {
		t.Errorf("after the next start: %s ended %v", tr.State, tr.EndedAt)
	}
}

// A sync that fails more files than the ledger keeps lists the first maxFailed of them, and so do
// Retryable and Retry. A retry copies those files and not the others. The test pins the current
// limit.
func TestSyncWithMoreFailuresThanKept(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("a file without permissions is readable here")
	}
	f := newFixture(t)
	ctx := context.Background()
	src, dst := t.TempDir(), t.TempDir()
	total := maxFailed + 100
	var locked []string
	for i := range total {
		p := filepath.Join(src, fmt.Sprintf("f%05d.txt", i))
		writeFile(t, p, 3)
		if err := os.Chmod(p, 0); err != nil {
			t.Fatal(err)
		}
		locked = append(locked, p)
	}
	unlock := func() {
		for _, p := range locked {
			_ = os.Chmod(p, 0o600)
		}
	}
	t.Cleanup(unlock)

	started, _ := f.s.Start(f.ctx, Spec{Form: operations.Form{Operation: "sync"}, Plan: syncOf(src, dst), Origin: page})
	if started.ID == "" {
		t.Fatal("nothing started")
	}
	tr := f.wait(started.ID)
	failed, err := f.s.Files(ctx, started.ID, FilesQuery{Outcome: OutcomeFailed})
	if err != nil || tr.State != StateFailed || failed.Total != maxFailed {
		t.Fatalf("state %s, %d failed listed (%v), want failed with %d", tr.State, failed.Total, err, maxFailed)
	}
	r, err := f.s.Retryable(ctx, started.ID)
	if err != nil || len(r.Items) != maxFailed || r.Refused != "" {
		t.Fatalf("%d retryable, refused %q (%v), want %d", len(r.Items), r.Refused, err, maxFailed)
	}

	unlock()
	again, err := f.s.Retry(f.ctx, started.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	rt := f.wait(again.ID)
	copied, err := os.ReadDir(dst)
	if err != nil || rt.State != StateCompleted || len(rt.Sources) != maxFailed || len(copied) != maxFailed {
		t.Errorf("the retry: %s with %d sources, %d copied (%v); want %d", rt.State, len(rt.Sources), len(copied), err, maxFailed)
	}
}

// A shutdown that races a start leaves nothing open, whichever one wins. A start that it refused
// recorded nothing. A start that it claimed ended interrupted within its wait, with its job
// stopped. A shutdown that begins while the start holds its row waits for the start to track
// its job, then claims it.
func TestShutdownRacingAStart(t *testing.T) {
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "big.bin"), 1<<20)
	start := func(f *fixture) (Started, error) {
		slow := planOf(operations.Step{Op: operations.OpCopyFile, Src: src, SrcRemote: "big.bin", Dst: memory(), DstRemote: "big.bin"})
		slow.Config = operations.Options{"bwlimit_file": "10K"}
		return f.s.Start(f.ctx, Spec{Form: operations.Form{Operation: "copy"}, Plan: slow, Origin: page})
	}
	// nothingOpen checks what the start returned against what it recorded.
	nothingOpen := func(t *testing.T, f *fixture, started Started, err error) {
		t.Helper()
		var recorded, open int
		if err := f.db.R.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE ended_ms IS NULL OR state != 'interrupted')
			FROM transfers`).Scan(&recorded, &open); err != nil {
			t.Fatal(err)
		}
		switch {
		case errors.Is(err, ErrShuttingDown) && (started.ID != "" || recorded != 0):
			t.Errorf("refused, yet %d recorded", recorded)
		case !errors.Is(err, ErrShuttingDown) && (err != nil || started.ID == "" || recorded != 1):
			t.Errorf("%+v %v, %d recorded", started, err, recorded)
		case open != 0:
			t.Errorf("%d left open or not interrupted", open)
		}
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		if len(f.s.running) != 0 {
			t.Errorf("%d jobs still tracked", len(f.s.running))
		}
	}

	t.Run("while the start holds its row", func(t *testing.T) {
		f := newFixture(t)
		shut := make(chan struct{})
		f.s.inserted = func(string) {
			go func() {
				f.s.Shutdown(context.Background(), false)
				close(shut)
			}()
		}
		started, err := start(f)
		select {
		case <-shut:
		case <-time.After(20 * time.Second):
			t.Fatal("the shutdown never returned")
		}
		nothingOpen(t, f, started, err)
		if started.ID == "" {
			t.Error("the start was refused after its row was inserted")
		}
	})

	t.Run("either first", func(t *testing.T) {
		for i := range 20 {
			f := newFixture(t)
			var (
				wg      sync.WaitGroup
				started Started
				err     error
			)
			ready := make(chan struct{})
			wg.Go(func() {
				<-ready
				started, err = start(f)
			})
			wg.Go(func() {
				<-ready
				time.Sleep(time.Duration(i) * 100 * time.Microsecond) // a little later each run
				f.s.Shutdown(context.Background(), false)
			})
			close(ready)
			done := make(chan struct{})
			go func() { wg.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(20 * time.Second):
				t.Fatalf("run %d: the start and the shutdown never both returned", i)
			}
			nothingOpen(t, f, started, err)
		}
	})
}
