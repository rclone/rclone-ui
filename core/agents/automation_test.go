package agents

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// A schedule is created from flat fields, listed, changed, paused, resumed, run at once (a copy
// between two folders, whose file arrives), and deleted. The forms that it can't run are refused.
func TestScheduleTools(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("scheduled"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"name": "x", "operation": "download", "sources": []string{src}, "destination": dst, "when": "@daily"}, "can't run"},
		{map[string]any{"name": "x", "operation": "sync", "sources": []string{src, src}, "destination": dst, "when": "@daily"}, "one source"},
		{map[string]any{"name": "x", "operation": "delete", "sources": []string{src}, "destination": dst, "when": "@daily"}, "no destination"},
		{map[string]any{"name": "x", "operation": "copy", "sources": []string{src}, "when": "@daily"}, "destination"},
		{map[string]any{"name": "x", "operation": "copy", "destination": dst, "when": "@daily"}, "sources"},
		{map[string]any{"name": "x", "operation": "copy", "sources": []string{src}, "destination": dst, "when": "daily"}, "5 fields"},
		{map[string]any{"name": "x", "operation": "copy", "sources": []string{src}, "destination": dst}, "cron"},
		{map[string]any{"operation": "copy", "sources": []string{src}, "destination": dst, "when": "@daily"}, "name"},
		{map[string]any{"schedule_id": "no-such-schedule", "when": "@daily"}, "deleted"},
	} {
		if _, failed := call[scheduleSaved](t, cs, "save_schedule", c.args); !strings.Contains(failed, c.want) {
			t.Errorf("%v: %q, want it to say %q", c.args, failed, c.want)
		}
	}

	saved := must[scheduleSaved](t, cs, "save_schedule", map[string]any{
		"name": "Nightly copy", "operation": "Copy", "sources": []string{"box:" + src}, "destination": dst, "when": "0 2 * * *",
		"options": map[string]any{"dry_run": true, "max_age": "7d", "no_such_option": 1},
	})
	sc := saved.Schedule
	t.Cleanup(func() { _ = apis.Schedules.Delete(t.Context(), sc.ID) })
	if sc.Name != "Nightly copy" || sc.Operation != "copy" || !slices.Equal(sc.Sources, []string{"box:" + src}) ||
		sc.Destination != dst || sc.When != "0 2 * * *" || sc.WhenInWords != "every day at 02:00" || sc.Paused || sc.NextRun == "" {
		t.Fatalf("save_schedule: %+v", sc)
	}
	if len(saved.NextRuns) != 3 || saved.NextRuns[0] != sc.NextRun {
		t.Errorf("next runs %v, next run %s", saved.NextRuns, sc.NextRun)
	}
	if len(sc.Options) != 1 || sc.Options["max_age"] != "7d" {
		t.Errorf("the saved options: %v", sc.Options)
	}
	var ignored []string
	for _, o := range saved.IgnoredOptions {
		ignored = append(ignored, o.Option)
	}
	if !slices.Equal(ignored, []string{"dry_run", "no_such_option"}) {
		t.Errorf("ignored options: %+v", saved.IgnoredOptions)
	}

	// A change keeps what it leaves out.
	edited := must[scheduleSaved](t, cs, "save_schedule", map[string]any{"schedule_id": sc.ID, "when": "30 18 * * 1-5"}).Schedule
	if edited.ID != sc.ID || edited.Name != sc.Name || !slices.Equal(edited.Sources, sc.Sources) || edited.Destination != dst ||
		edited.WhenInWords != "every weekday (Monday to Friday) at 18:30" || edited.Options["max_age"] != "7d" {
		t.Errorf("after changing when: %+v", edited)
	}
	other := must[scheduleSaved](t, cs, "save_schedule", map[string]any{
		"name": "Weekly purge", "operation": "purge", "sources": []string{"box:" + t.TempDir()}, "when": "@weekly",
	}).Schedule
	t.Cleanup(func() { _ = apis.Schedules.Delete(t.Context(), other.ID) })
	if other.Destination != "" || other.WhenInWords != "every Sunday at 00:00" {
		t.Errorf("a purge: %+v", other)
	}
	list := must[scheduleList](t, cs, "list_schedules", nil)
	if list.Total < 2 || list.Truncated || !slices.ContainsFunc(list.Schedules, func(s scheduleItem) bool { return s.ID == sc.ID }) {
		t.Errorf("list_schedules: %+v", list)
	}
	if short := must[scheduleList](t, cs, "list_schedules", map[string]any{"limit": 1}); len(short.Schedules) != 1 || !short.Truncated || short.Total != list.Total {
		t.Errorf("list_schedules with a limit: %+v", short)
	}

	if p := must[scheduleItem](t, cs, "pause_schedule", map[string]any{"schedule_id": sc.ID}); !p.Paused || p.NextRun != "" {
		t.Errorf("pause_schedule: %+v", p)
	}
	if r := must[scheduleItem](t, cs, "resume_schedule", map[string]any{"schedule_id": sc.ID}); r.Paused || r.NextRun == "" {
		t.Errorf("resume_schedule: %+v", r)
	}

	run := must[scheduleRun](t, cs, "run_schedule_now", map[string]any{"schedule_id": sc.ID})
	if run.TransferID == "" {
		t.Fatalf("run_schedule_now: %+v", run)
	}
	// A copy puts a folder that it copies inside the destination.
	testutil.Eventually(t, time.Minute, "the copied file", func() bool {
		b, err := os.ReadFile(filepath.Join(dst, filepath.Base(src), "a.txt"))
		return err == nil && string(b) == "scheduled"
	})
	testutil.Eventually(t, time.Minute, "the run's end", func() bool {
		l, failed := call[scheduleList](t, cs, "list_schedules", nil)
		i := slices.IndexFunc(l.Schedules, func(s scheduleItem) bool { return s.ID == sc.ID })
		return failed == "" && i >= 0 && !l.Schedules[i].Running && l.Schedules[i].LastResult == "completed" &&
			l.Schedules[i].LastTransferID == run.TransferID
	})

	if got := must[removed](t, cs, "delete_schedule", map[string]any{"schedule_id": sc.ID}); got.Deleted != "Nightly copy" {
		t.Errorf("delete_schedule: %+v", got)
	}
	if _, failed := call[removed](t, cs, "delete_schedule", map[string]any{"schedule_id": sc.ID}); !strings.Contains(failed, "deleted") {
		t.Errorf("deleting it twice: %q", failed)
	}
	if _, failed := call[scheduleRun](t, cs, "run_schedule_now", map[string]any{"schedule_id": sc.ID}); !strings.Contains(failed, "deleted") {
		t.Errorf("running a deleted schedule: %q", failed)
	}
}

// cronInWords says the drawer's shapes in words, and nothing for any other expression.
func TestCronInWords(t *testing.T) {
	for expr, want := range map[string]string{
		"@hourly":       "every hour at :00",
		"@monthly":      "every month on day 1 at 00:00",
		"5 * * * *":     "every hour at :05",
		"0 2 * * *":     "every day at 02:00",
		"0 9 * * mon":   "every Monday at 09:00",
		"0 9 * * 7":     "every Sunday at 09:00",
		"0 3 15 * *":    "every month on day 15 at 03:00",
		"*/15 * * * *":  "",
		"0 2 * 1 *":     "",
		"0 2 1 * 1":     "",
		"0 2,14 * * *":  "",
		"not a cron":    "",
		"60 2 * * *":    "",
		"0 9 * * 1-3":   "",
		"0 18 * * 1-5 ": "every weekday (Monday to Friday) at 18:00",
	} {
		if got := cronInWords(expr); got != want {
			t.Errorf("%q: %q, want %q", expr, got, want)
		}
	}
}

// A watcher is created, merges its two folders at once, is listed, renamed, paused, resumed,
// synced now, and deleted. Folders that can't be kept the same are refused.
func TestWatcherTools(t *testing.T) {
	cs := connect(t)
	a, b := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(a, "note.txt"), []byte("watched"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"name": "x", "folder_a": a, "folder_b": a}, "same folder"},
		{map[string]any{"name": "x", "folder_a": a, "folder_b": filepath.Join(a, "inside")}, "inside"},
		{map[string]any{"name": "x", "folder_a": a}, "folder_b"},
		{map[string]any{"folder_a": a, "folder_b": b}, "name"},
		{map[string]any{"watcher_id": "no-such-watcher", "name": "x"}, "no longer exists"},
	} {
		if _, failed := call[watcherItem](t, cs, "save_watcher", c.args); !strings.Contains(failed, c.want) {
			t.Errorf("%v: %q, want it to say %q", c.args, failed, c.want)
		}
	}

	w := must[watcherItem](t, cs, "save_watcher", map[string]any{"name": "Notes", "folder_a": a, "folder_b": "box:" + b})
	t.Cleanup(func() { _ = apis.Watchers.Delete(t.Context(), w.ID) })
	if w.Name != "Notes" || w.FolderA != a || w.FolderB != "box:"+b || w.Paused || w.State != "initializing" {
		t.Fatalf("save_watcher: %+v", w)
	}
	testutil.Eventually(t, time.Minute, "the first merge", func() bool {
		got, err := os.ReadFile(filepath.Join(b, "note.txt"))
		return err == nil && string(got) == "watched"
	})
	testutil.Eventually(t, time.Minute, "an active watcher", func() bool {
		list, failed := call[watcherList](t, cs, "list_watchers", nil)
		i := slices.IndexFunc(list.Watchers, func(x watcherItem) bool { return x.ID == w.ID })
		return failed == "" && i >= 0 && list.Watchers[i].State == "active" && list.Watchers[i].LastRunAt != ""
	})

	renamed := must[watcherItem](t, cs, "save_watcher", map[string]any{"watcher_id": w.ID, "name": "Notes on box"})
	if renamed.Name != "Notes on box" || renamed.FolderA != a || renamed.FolderB != "box:"+b || renamed.State != "active" {
		t.Errorf("after a rename: %+v", renamed)
	}
	other := must[watcherItem](t, cs, "save_watcher", map[string]any{"name": "Other", "folder_a": t.TempDir(), "folder_b": t.TempDir()})
	t.Cleanup(func() { _ = apis.Watchers.Delete(t.Context(), other.ID) })
	list := must[watcherList](t, cs, "list_watchers", nil)
	if list.Total < 2 || list.Truncated {
		t.Errorf("list_watchers: %+v", list)
	}
	if short := must[watcherList](t, cs, "list_watchers", map[string]any{"limit": 1}); len(short.Watchers) != 1 || !short.Truncated {
		t.Errorf("list_watchers with a limit: %+v", short)
	}

	if p := must[watcherItem](t, cs, "pause_watcher", map[string]any{"watcher_id": w.ID}); !p.Paused || p.State != "paused" {
		t.Errorf("pause_watcher: %+v", p)
	}
	if r := must[watcherItem](t, cs, "resume_watcher", map[string]any{"watcher_id": w.ID}); r.Paused {
		t.Errorf("resume_watcher: %+v", r)
	}
	if err := os.WriteFile(filepath.Join(b, "back.txt"), []byte("the other way"), 0o600); err != nil {
		t.Fatal(err)
	}
	must[watcherItem](t, cs, "sync_watcher_now", map[string]any{"watcher_id": w.ID})
	testutil.Eventually(t, time.Minute, "a file from folder B", func() bool {
		got, err := os.ReadFile(filepath.Join(a, "back.txt"))
		return err == nil && string(got) == "the other way"
	})

	if got := must[removed](t, cs, "delete_watcher", map[string]any{"watcher_id": w.ID}); got.Deleted != "Notes on box" {
		t.Errorf("delete_watcher: %+v", got)
	}
	if _, failed := call[watcherItem](t, cs, "sync_watcher_now", map[string]any{"watcher_id": w.ID}); !strings.Contains(failed, "no longer exists") {
		t.Errorf("syncing a deleted watcher: %q", failed)
	}
	if _, err := os.Stat(filepath.Join(a, "note.txt")); err != nil {
		t.Errorf("the folder lost its file when the watcher was deleted: %v", err)
	}
}
