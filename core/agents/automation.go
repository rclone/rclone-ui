package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/schedules"
	"github.com/rclone/rclone-ui/core/watchers"
)

// The tools for what runs by itself: schedules, which run a transfer at set times, and watchers,
// which keep two folders the same.

func (s *Server) automationTools() {
	s.listSchedulesTool()
	s.saveScheduleTool()
	s.deleteScheduleTool()
	s.pauseScheduleTool()
	s.resumeScheduleTool()
	s.runScheduleNowTool()
	s.listWatchersTool()
	s.saveWatcherTool()
	s.deleteWatcherTool()
	s.pauseWatcherTool()
	s.resumeWatcherTool()
	s.syncWatcherNowTool()
}

// The limits of list_schedules and list_watchers.
const (
	automationLimit    = 100
	automationLimitMax = 500
)

// automationCap returns how many of n items a list returns for the limit an agent asked for.
func automationCap(n, limit int) int {
	if limit <= 0 {
		limit = automationLimit
	}
	return min(n, limit, automationLimitMax)
}

// rfc3339MS returns a time in milliseconds as RFC 3339, in this computer's time zone, or "" for
// none.
func rfc3339MS(ms *int64) string {
	if ms == nil {
		return ""
	}
	return time.UnixMilli(*ms).Format(time.RFC3339)
}

// removed is what the tools that delete a schedule or a watcher return.
type removed struct {
	Deleted string `json:"deleted" jsonschema:"the name of what was deleted"`
}

// scheduleOps are the operations that a schedule runs, for the refusals.
const scheduleOps = "copy, move, sync, bisync, delete or purge"

// cronInWords says a cron expression in words, in this computer's time zone, for the shapes that
// the app's schedule drawer writes (src/components/schedule/when.ts): "every day at 02:00". It
// returns "" for any other expression, which an agent reads as it is.
func cronInWords(expr string) string {
	switch strings.ToLower(strings.TrimSpace(expr)) {
	case "@hourly":
		return "every hour at :00"
	case "@daily":
		return "every day at 00:00"
	case "@weekly":
		return "every Sunday at 00:00"
	case "@monthly":
		return "every month on day 1 at 00:00"
	}
	f := strings.Fields(expr)
	if len(f) != 5 || f[3] != "*" {
		return ""
	}
	minute, ok := cronNumber(f[0], 0, 59)
	if !ok {
		return ""
	}
	if f[1] == "*" && f[2] == "*" && f[4] == "*" {
		return fmt.Sprintf("every hour at :%02d", minute)
	}
	hour, ok := cronNumber(f[1], 0, 23)
	if !ok {
		return ""
	}
	at := fmt.Sprintf("%02d:%02d", hour, minute)
	switch {
	case f[2] == "*" && f[4] == "*":
		return "every day at " + at
	case f[2] == "*" && (f[4] == "1-5" || strings.EqualFold(f[4], "mon-fri")):
		return "every weekday (Monday to Friday) at " + at
	case f[2] == "*":
		if day, ok := cronNumber(f[4], 0, 7); ok {
			return "every " + time.Weekday(day%7).String() + " at " + at
		}
		for day := time.Sunday; day <= time.Saturday; day++ {
			if strings.EqualFold(f[4], day.String()[:3]) {
				return "every " + day.String() + " at " + at
			}
		}
	case f[4] == "*":
		if day, ok := cronNumber(f[2], 1, 31); ok {
			return fmt.Sprintf("every month on day %d at %s", day, at)
		}
	}
	return ""
}

// cronNumber reads a cron field that is one plain number between lo and hi.
func cronNumber(field string, lo, hi int) (int, bool) {
	n, err := strconv.Atoi(field)
	if err != nil || n < lo || n > hi || strings.ContainsAny(field, "+-") {
		return 0, false
	}
	return n, true
}

// flatOptions returns the options of a form's groups as one map, by rclone's name, as an agent
// gives them. Bisync's switches and the per-remote overrides aren't options, and are left out.
func flatOptions(g *operations.Groups) map[string]any {
	if g == nil {
		return nil
	}
	out := map[string]any{}
	for _, group := range g.Named() {
		for key, raw := range group {
			var v any
			if json.Unmarshal(raw, &v) == nil && v != nil {
				out[catalog.NormalizeOptionName(key)] = v
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// scheduleForm builds the form that a schedule runs from an agent's flat fields. It refuses what
// the operation's form can't hold, so that an agent can't save a form that means something else:
// a sync and a bisync take one source, and a delete and a purge take no destination.
func scheduleForm(op operations.Operation, sources []string, destination string, g operations.Groups) (operations.Form, error) {
	if len(sources) == 0 {
		return operations.Form{}, errs.Errorf("Give the sources that the %s reads, such as [\"gdrive:Photos\"].", op)
	}
	switch op {
	case operations.OperationDelete, operations.OperationPurge:
		if destination != "" {
			return operations.Form{}, errs.Errorf("A %s takes no destination: it deletes its sources.", op)
		}
		if op == operations.OperationDelete {
			return operations.DeleteArgs{Sources: sources, Options: g}.Form(), nil
		}
		return operations.PurgeArgs{Sources: sources, Options: g}.Form(), nil
	}
	if destination == "" {
		return operations.Form{}, errs.Errorf("Give the destination that the %s writes to.", op)
	}
	switch op {
	case operations.OperationCopy:
		return operations.CopyArgs{Sources: sources, Destination: destination, Options: g}.Form(), nil
	case operations.OperationMove:
		return operations.MoveArgs{Sources: sources, Destination: destination, Options: g}.Form(), nil
	}
	if len(sources) != 1 {
		return operations.Form{}, errs.Errorf("A %s takes one source.", op)
	}
	if op == operations.OperationSync {
		return operations.SyncArgs{Source: sources[0], Destination: destination, Options: g}.Form(), nil
	}
	return operations.BisyncArgs{Source: sources[0], Destination: destination, Options: g}.Form(), nil
}

// takesDestination reports whether an operation that a schedule runs writes to a destination.
func takesDestination(op operations.Operation) bool {
	return op != operations.OperationDelete && op != operations.OperationPurge
}

// scheduleItem is a schedule, as the schedule tools return it.
type scheduleItem struct {
	ID          string         `json:"id" jsonschema:"the schedule's id, for the other schedule tools"`
	Name        string         `json:"name"`
	Operation   string         `json:"operation" jsonschema:"copy, move, sync, bisync, delete or purge"`
	Sources     []string       `json:"sources"`
	Destination string         `json:"destination,omitempty"`
	Options     map[string]any `json:"options,omitempty" jsonschema:"rclone's options that each run uses, by name"`
	When        string         `json:"when" jsonschema:"the cron expression, in this computer's time zone"`
	WhenInWords string         `json:"when_in_words,omitempty" jsonschema:"the same in words, for the common shapes"`
	Paused      bool           `json:"paused"`
	NextRun     string         `json:"next_run,omitempty" jsonschema:"when it runs next, or nothing while it is paused"`
	// Running is set while a run is in progress, with its transfer once it has started.
	Running           bool   `json:"running,omitempty"`
	RunningTransferID string `json:"running_transfer_id,omitempty"`
	LastRunAt         string `json:"last_run_at,omitempty" jsonschema:"when the last run ended"`
	LastResult        string `json:"last_result,omitempty" jsonschema:"how the last run ended: completed, nothing (nothing to do), failed, stopped or interrupted"`
	LastError         string `json:"last_error,omitempty"`
	LastTransferID    string `json:"last_transfer_id,omitempty" jsonschema:"the last run's transfer, for get_transfer and History"`
}

// scheduleItemOf converts a schedule.
func scheduleItemOf(sc schedules.Schedule) scheduleItem {
	sources, destination := sc.Form.Ends()
	if sources == nil {
		sources = []string{}
	}
	return scheduleItem{
		ID: sc.ID, Name: sc.Name, Operation: string(sc.Form.Operation), Sources: sources, Destination: destination,
		Options: flatOptions(sc.Form.Groups()), When: sc.When, WhenInWords: cronInWords(sc.When), Paused: sc.Paused,
		NextRun: rfc3339MS(sc.NextRun), Running: sc.Running, RunningTransferID: sc.RunningID,
		LastRunAt: rfc3339MS(sc.LastRunAt), LastResult: sc.LastResult, LastError: sc.LastError,
		LastTransferID: sc.LastTransferID,
	}
}

type schedulesIn struct {
	Limit int `json:"limit,omitempty" jsonschema:"how many schedules to return: 100 when left out, 500 at most"`
}

type scheduleList struct {
	Schedules []scheduleItem `json:"schedules"`
	Total     int            `json:"total"`
	// Truncated is set when there are more schedules than were returned.
	Truncated bool `json:"truncated,omitempty" jsonschema:"there are more: call again with a higher limit"`
}

func (s *Server) listSchedulesTool() {
	add(s, &mcp.Tool{
		Name: "list_schedules",
		Description: "The user's schedules, sorted by name. A schedule runs a copy, move, sync, bisync, delete or purge at set times " +
			"while the app is open. Each has its id, what it runs (operation, sources, destination, options), when " +
			"(the cron expression, and in words), whether it is paused, its next run, and how its last run ended.",
		Annotations: reads("List schedules"),
	}, func(ctx context.Context, in schedulesIn) (scheduleList, error) {
		all, err := s.o.APIs.Schedules.List(ctx)
		if err != nil {
			return scheduleList{}, err
		}
		n := automationCap(len(all), in.Limit)
		out := scheduleList{Schedules: make([]scheduleItem, 0, n), Total: len(all), Truncated: n < len(all)}
		for _, sc := range all[:n] {
			out.Schedules = append(out.Schedules, scheduleItemOf(sc))
		}
		return out, nil
	})
}

type saveScheduleIn struct {
	ScheduleID  string         `json:"schedule_id,omitempty" jsonschema:"the schedule to change, from list_schedules. Leave it out to create one. When changing one, the fields left out keep their saved values."`
	Name        string         `json:"name,omitempty" jsonschema:"a name that no other schedule has, such as Nightly photos backup"`
	Operation   string         `json:"operation,omitempty" jsonschema:"what each run does: copy, move, sync, bisync, delete or purge"`
	Sources     []string       `json:"sources,omitempty" jsonschema:"the paths that a run reads, such as [\"gdrive:Photos\"]: one for a sync or a bisync, one or more for the others"`
	Destination string         `json:"destination,omitempty" jsonschema:"where a copy, move, sync or bisync writes, such as /Users/me/Backup/Photos. A delete and a purge take none."`
	When        string         `json:"when,omitempty" jsonschema:"when it runs, in this computer's time zone: a cron expression of 5 fields (minute, hour, day of month, month, day of week), or @hourly, @daily, @weekly or @monthly. Examples: \"0 2 * * *\" every day at 02:00, \"30 18 * * 1-5\" Monday to Friday at 18:30, \"0 9 * * MON\" every Monday at 09:00, \"0 3 1 * *\" the 1st of each month at 03:00, \"*/15 * * * *\" every 15 minutes."`
	Options     map[string]any `json:"options,omitempty" jsonschema:"rclone's options for each run, by name, such as {\"max_age\": \"7d\", \"exclude\": [\"*.tmp\"]}. When changing a schedule, these replace its saved options."`
}

// scheduleSaved is what save_schedule returns: the schedule, and what it found while saving.
type scheduleSaved struct {
	Schedule scheduleItem `json:"schedule"`
	// NextRuns are the next 3 times it runs.
	NextRuns []string `json:"next_runs,omitempty" jsonschema:"the next 3 times it runs, unless it is paused"`
	Warning  string   `json:"warning,omitempty"`
	// IgnoredOptions are the options that the operation doesn't use, which weren't saved.
	IgnoredOptions []optionLeftOut `json:"ignored_options,omitempty"`
}

func (s *Server) saveScheduleTool() {
	add(s, &mcp.Tool{
		Name: "save_schedule",
		Description: "Creates a schedule, or changes one when schedule_id is given. A schedule runs an operation at the times of `when`, " +
			"while the app is open, and each run shows in History. It can run a sync, move, delete, purge or bisync, which delete or " +
			"overwrite files, again and again without asking: run the same operation once with the transfer tools' dry_run first, " +
			"and tell the user what it would do. The form is checked as a run would check it, which reads the sources. " +
			"A new schedule runs from its next time on: use pause_schedule to keep it from running. dry_run is never saved. " +
			"Options that the operation doesn't use come back in ignored_options.",
		Annotations: destroys("Save a schedule"),
	}, func(ctx context.Context, in saveScheduleIn) (scheduleSaved, error) {
		var saved *schedules.Schedule
		if in.ScheduleID != "" {
			sc, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
			if err != nil {
				return scheduleSaved{}, err
			}
			saved = &sc
		}
		name, when := in.Name, in.When
		op := operations.Operation(strings.ToLower(strings.TrimSpace(in.Operation)))
		sources, destination := in.Sources, in.Destination
		var old *operations.Groups
		if saved != nil {
			oldSources, oldDestination := saved.Form.Ends()
			if name == "" {
				name = saved.Name
			}
			if when == "" {
				when = saved.When
			}
			if op == "" {
				op = saved.Form.Operation
			}
			if len(sources) == 0 {
				sources = oldSources
			}
			if destination == "" && takesDestination(op) {
				destination = oldDestination
			}
			old = saved.Form.Groups()
		}
		switch {
		case strings.TrimSpace(name) == "":
			return scheduleSaved{}, errs.New("Give the schedule a name.")
		case op == "":
			return scheduleSaved{}, errs.Errorf("Give the operation that the schedule runs: %s.", scheduleOps)
		case !slices.Contains(schedules.Operations, op):
			return scheduleSaved{}, errs.Errorf("A schedule can't run %q: it runs a %s.", in.Operation, scheduleOps)
		case strings.TrimSpace(when) == "":
			return scheduleSaved{}, errs.New("Give when the schedule runs, as a cron expression such as \"0 2 * * *\".")
		}

		// A dry run is for one run, so a schedule never keeps it.
		var ignored []optionLeftOut
		flat := maps.Clone(in.Options)
		for key := range in.Options {
			if catalog.NormalizeOptionName(key) == "dry_run" {
				delete(flat, key)
				ignored = append(ignored, optionLeftOut{Option: key, Reason: "A schedule doesn't keep a dry run, which is for a single run."})
			}
		}
		var groups operations.Groups
		var left []optionLeftOut
		var err error
		switch {
		case in.Options != nil || old == nil:
			groups, left, err = optionGroupsFor(op, "", flat)
		case op == saved.Form.Operation:
			groups = *old
		default: // the saved options, sorted again for the new operation
			groups, left, err = optionGroupsFor(op, "", flatOptions(old))
		}
		if err != nil {
			return scheduleSaved{}, err
		}
		// The per-remote overrides, and bisync's switches, are set in the app's windows. A change
		// of the options keeps them.
		if old != nil {
			if groups.Remotes == nil {
				groups.Remotes = old.Remotes
			}
			if groups.Outer == nil && op == operations.OperationBisync && saved.Form.Operation == op {
				groups.Outer = old.Outer
			}
		}
		form, err := scheduleForm(op, sources, destination, groups)
		if err != nil {
			return scheduleSaved{}, err
		}
		sc, err := s.o.APIs.Schedules.Save(ctx, schedules.Input{ID: in.ScheduleID, Name: name, Form: form, When: when})
		if err != nil {
			return scheduleSaved{}, err
		}
		out := scheduleSaved{Schedule: scheduleItemOf(sc), Warning: sc.Warning, IgnoredOptions: append(ignored, left...)}
		if !sc.Paused {
			if d, err := s.o.APIs.Schedules.Describe(ctx, sc.When); err == nil {
				for _, ms := range d.Next {
					out.NextRuns = append(out.NextRuns, rfc3339MS(&ms))
				}
			}
		}
		return out, nil
	})
}

type scheduleIDIn struct {
	ScheduleID string `json:"schedule_id" jsonschema:"the schedule's id, from list_schedules"`
}

func (s *Server) deleteScheduleTool() {
	add(s, &mcp.Tool{
		Name: "delete_schedule",
		Description: "Deletes a schedule, so it never runs again. A run in progress goes on. Its past runs stay in History. " +
			"To stop it for a while instead, use pause_schedule.",
		Annotations: destroys("Delete a schedule"),
	}, func(ctx context.Context, in scheduleIDIn) (removed, error) {
		sc, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
		if err != nil {
			return removed{}, err
		}
		if err := s.o.APIs.Schedules.Delete(ctx, in.ScheduleID); err != nil {
			return removed{}, err
		}
		return removed{Deleted: sc.Name}, nil
	})
}

func (s *Server) pauseScheduleTool() {
	add(s, &mcp.Tool{
		Name:        "pause_schedule",
		Description: "Pauses a schedule: it doesn't run at its times until resume_schedule. A run in progress goes on. Returns the schedule.",
		Annotations: changes("Pause a schedule"),
	}, func(ctx context.Context, in scheduleIDIn) (scheduleItem, error) {
		if err := s.o.APIs.Schedules.Pause(ctx, in.ScheduleID); err != nil {
			return scheduleItem{}, err
		}
		sc, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
		return scheduleItemOf(sc), err
	})
}

func (s *Server) resumeScheduleTool() {
	add(s, &mcp.Tool{
		Name: "resume_schedule",
		Description: "Resumes a paused schedule: it runs again from its next time on, and the times it missed while paused are skipped. " +
			"Its runs may delete or overwrite files, as its operation does. Returns the schedule, with its next run.",
		Annotations: destroys("Resume a schedule"),
	}, func(ctx context.Context, in scheduleIDIn) (scheduleItem, error) {
		if err := s.o.APIs.Schedules.Resume(ctx, in.ScheduleID); err != nil {
			return scheduleItem{}, err
		}
		sc, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
		return scheduleItemOf(sc), err
	})
}

// scheduleRun is what run_schedule_now returns.
type scheduleRun struct {
	TransferID string `json:"transfer_id,omitempty" jsonschema:"the run's transfer: follow it with wait_for_transfer or get_transfer"`
	Running    bool   `json:"running" jsonschema:"the run is in progress"`
	// Result and Error are set when the run ended before the tool returned.
	Result string `json:"result,omitempty" jsonschema:"how the run ended, when it ended at once: completed, nothing (nothing to do), failed, stopped or interrupted"`
	Error  string `json:"error,omitempty"`
}

// runStartWait is how long run_schedule_now waits for the run's transfer to start.
const runStartWait = 10 * time.Second

func (s *Server) runScheduleNowTool() {
	add(s, &mcp.Tool{
		Name: "run_schedule_now",
		Description: "Runs a schedule once now, paused or not, without changing its times. It can delete or overwrite files, as the " +
			"schedule's operation does. It returns once the run has started, with its transfer_id: follow it with wait_for_transfer " +
			"or get_transfer. History and list_transfers show it too. A schedule that is running already is refused.",
		Annotations: destroys("Run a schedule now"),
	}, func(ctx context.Context, in scheduleIDIn) (scheduleRun, error) {
		before, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
		if err != nil {
			return scheduleRun{}, err
		}
		if err := s.o.APIs.Schedules.RunNow(ctx, in.ScheduleID); err != nil {
			return scheduleRun{}, err
		}
		// The run's transfer starts in the background, and the schedule names it once it has.
		ctx, cancel := context.WithTimeout(ctx, runStartWait)
		defer cancel()
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			sc, err := s.o.APIs.Schedules.Get(ctx, in.ScheduleID)
			switch {
			case err != nil:
				return scheduleRun{Running: true}, nil // it started, and ctx ended
			case sc.RunningID != "":
				return scheduleRun{TransferID: sc.RunningID, Running: true}, nil
			case !sc.Running:
				out := scheduleRun{}
				if rfc3339MS(sc.LastRunAt) != rfc3339MS(before.LastRunAt) || sc.LastTransferID != before.LastTransferID {
					out.TransferID, out.Result, out.Error = sc.LastTransferID, sc.LastResult, sc.LastError
				}
				return out, nil
			}
			select {
			case <-ctx.Done():
				return scheduleRun{Running: true}, nil
			case <-tick.C:
			}
		}
	})
}

// watcherItem is a watcher, as the watcher tools return it.
type watcherItem struct {
	ID      string `json:"id" jsonschema:"the watcher's id, for the other watcher tools"`
	Name    string `json:"name"`
	FolderA string `json:"folder_a"`
	FolderB string `json:"folder_b"`
	Paused  bool   `json:"paused"`
	State   string `json:"state" jsonschema:"initializing (its first merge of the two folders hasn't succeeded yet), active, paused, failing (its runs fail, and it tries again every minute) or needs_attention"`
	// Attention says why the watcher stopped until the user acts.
	Attention      string `json:"attention,omitempty" jsonschema:"why it stopped and what the user can do, when it needs attention"`
	LastError      string `json:"last_error,omitempty"`
	LastRunAt      string `json:"last_run_at,omitempty" jsonschema:"when its last run ended"`
	LastChangeAt   string `json:"last_change_at,omitempty" jsonschema:"when its last run that changed a file ended"`
	LastTransferID string `json:"last_transfer_id,omitempty" jsonschema:"its last run that changed something or failed, for get_transfer and History"`
}

// watcherItemOf converts a watcher. Its state is the one that the Watchers window shows
// (src/pages/Watchers/status.ts).
func watcherItemOf(w watchers.Watcher) watcherItem {
	out := watcherItem{
		ID: w.ID, Name: w.Name, FolderA: w.PathA, FolderB: w.PathB, Paused: w.Paused, LastError: w.LastError,
		LastRunAt: rfc3339MS(w.LastRunAt), LastChangeAt: rfc3339MS(w.LastChangeAt), LastTransferID: w.LastTransferID,
	}
	lost := "one of the folders"
	switch w.DeletedSide {
	case watchers.SideA:
		lost = w.PathA
	case watchers.SideB:
		lost = w.PathB
	}
	switch {
	case w.Resyncing:
		out.State = "initializing"
	case w.Attention != "":
		out.State = "needs_attention"
		switch w.Attention {
		case watchers.AttentionResync:
			out.Attention = "bisync can only go on after the two folders are merged again. "
		case watchers.AttentionDeletes:
			out.Attention = "Many files were deleted in " + lost + " since the last sync, so the watcher stopped to make sure that was meant. "
		case watchers.AttentionEmptied:
			out.Attention = "Every file in " + lost + " is gone since the last sync, so the watcher stopped to make sure that was meant. "
		}
		out.Attention += "The user decides what to do in the app's Watchers window (open_window watchers)."
	case w.Paused:
		out.State = "paused"
	case w.LastResult == watchers.ResultFailed:
		out.State = "failing"
	case !w.Baselined:
		out.State = "initializing"
	default:
		out.State = "active"
	}
	return out
}

type watchersIn struct {
	Limit int `json:"limit,omitempty" jsonschema:"how many watchers to return: 100 when left out, 500 at most"`
}

type watcherList struct {
	Watchers []watcherItem `json:"watchers"`
	Total    int           `json:"total"`
	// Truncated is set when there are more watchers than were returned.
	Truncated bool `json:"truncated,omitempty" jsonschema:"there are more: call again with a higher limit"`
}

func (s *Server) listWatchersTool() {
	add(s, &mcp.Tool{
		Name: "list_watchers",
		Description: "The user's watchers, sorted by name. A watcher keeps two folders the same in both directions while the app is open: " +
			"every minute, it copies new and changed files each way and deletes on one side what was deleted on the other. " +
			"Each has its id, its two folders, whether it is paused, its state, and its last error.",
		Annotations: reads("List watchers"),
	}, func(ctx context.Context, in watchersIn) (watcherList, error) {
		all, err := s.o.APIs.Watchers.List(ctx)
		if err != nil {
			return watcherList{}, err
		}
		n := automationCap(len(all), in.Limit)
		out := watcherList{Watchers: make([]watcherItem, 0, n), Total: len(all), Truncated: n < len(all)}
		for _, w := range all[:n] {
			out.Watchers = append(out.Watchers, watcherItemOf(w))
		}
		return out, nil
	})
}

type saveWatcherIn struct {
	WatcherID string `json:"watcher_id,omitempty" jsonschema:"the watcher to change, from list_watchers. Leave it out to create one. When changing one, the fields left out keep their saved values."`
	Name      string `json:"name,omitempty" jsonschema:"a name that no other watcher has, such as Notes on Drive"`
	FolderA   string `json:"folder_a,omitempty" jsonschema:"one of the two folders, such as /Users/me/Notes"`
	FolderB   string `json:"folder_b,omitempty" jsonschema:"the other folder, such as gdrive:Notes. Neither folder can be inside the other."`
}

func (s *Server) saveWatcherTool() {
	add(s, &mcp.Tool{
		Name: "save_watcher",
		Description: "Creates a watcher, or changes one when watcher_id is given. A watcher keeps two folders the same in both directions " +
			"while the app is open: every minute, it copies new and changed files each way, and deletes in one folder what was deleted " +
			"in the other. A new watcher, or one whose folders changed, first merges the two folders at once: files missing on one side " +
			"are copied over, the newer file wins where both have one, and nothing is deleted. Returns the watcher.",
		Annotations: destroys("Save a watcher"),
	}, func(ctx context.Context, in saveWatcherIn) (watcherItem, error) {
		w := watchers.Input{ID: in.WatcherID, Name: in.Name, PathA: in.FolderA, PathB: in.FolderB}
		if in.WatcherID != "" {
			saved, err := s.o.APIs.Watchers.Get(ctx, in.WatcherID)
			if err != nil {
				return watcherItem{}, err
			}
			if w.Name == "" {
				w.Name = saved.Name
			}
			if w.PathA == "" {
				w.PathA = saved.PathA
			}
			if w.PathB == "" {
				w.PathB = saved.PathB
			}
		}
		switch {
		case strings.TrimSpace(w.Name) == "":
			return watcherItem{}, errs.New("Give the watcher a name.")
		case strings.TrimSpace(w.PathA) == "" || strings.TrimSpace(w.PathB) == "":
			return watcherItem{}, errs.New("Give both folders: folder_a and folder_b.")
		}
		saved, err := s.o.APIs.Watchers.Save(ctx, w)
		if err != nil {
			return watcherItem{}, err
		}
		return watcherItemOf(saved), nil
	})
}

type watcherIDIn struct {
	WatcherID string `json:"watcher_id" jsonschema:"the watcher's id, from list_watchers"`
}

func (s *Server) deleteWatcherTool() {
	add(s, &mcp.Tool{
		Name: "delete_watcher",
		Description: "Deletes a watcher, and stops its run in progress. The two folders and their files stay as they are: " +
			"they just stop being kept the same. To stop it for a while instead, use pause_watcher.",
		Annotations: destroys("Delete a watcher"),
	}, func(ctx context.Context, in watcherIDIn) (removed, error) {
		w, err := s.o.APIs.Watchers.Get(ctx, in.WatcherID)
		if err != nil {
			return removed{}, err
		}
		if err := s.o.APIs.Watchers.Delete(ctx, in.WatcherID); err != nil {
			return removed{}, err
		}
		return removed{Deleted: w.Name}, nil
	})
}

func (s *Server) pauseWatcherTool() {
	add(s, &mcp.Tool{
		Name:        "pause_watcher",
		Description: "Pauses a watcher: it stops keeping its two folders the same until resume_watcher. Returns the watcher.",
		Annotations: changes("Pause a watcher"),
	}, func(ctx context.Context, in watcherIDIn) (watcherItem, error) {
		if err := s.o.APIs.Watchers.Pause(ctx, in.WatcherID); err != nil {
			return watcherItem{}, err
		}
		w, err := s.o.APIs.Watchers.Get(ctx, in.WatcherID)
		return watcherItemOf(w), err
	})
}

func (s *Server) resumeWatcherTool() {
	add(s, &mcp.Tool{
		Name: "resume_watcher",
		Description: "Resumes a paused watcher: it syncs its two folders at once, and every minute after. A sync deletes in one folder " +
			"what was deleted in the other while it was paused. Returns the watcher.",
		Annotations: destroys("Resume a watcher"),
	}, func(ctx context.Context, in watcherIDIn) (watcherItem, error) {
		if err := s.o.APIs.Watchers.Resume(ctx, in.WatcherID); err != nil {
			return watcherItem{}, err
		}
		w, err := s.o.APIs.Watchers.Get(ctx, in.WatcherID)
		return watcherItemOf(w), err
	})
}

func (s *Server) syncWatcherNowTool() {
	add(s, &mcp.Tool{
		Name: "sync_watcher_now",
		Description: "Syncs a watcher's two folders now, without waiting for its next minute, unless a run is in progress. " +
			"A sync deletes in one folder what was deleted in the other. It returns at once: the run shows in History when it " +
			"changes something or fails, and list_watchers shows how it ended.",
		Annotations: destroys("Sync a watcher now"),
	}, func(ctx context.Context, in watcherIDIn) (watcherItem, error) {
		if err := s.o.APIs.Watchers.SyncNow(ctx, in.WatcherID); err != nil {
			return watcherItem{}, err
		}
		w, err := s.o.APIs.Watchers.Get(ctx, in.WatcherID)
		return watcherItemOf(w), err
	})
}
