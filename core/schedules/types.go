package schedules

import (
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

// Schedule is a schedule as the pages see it: an operation's form that runs at the times of a
// cron expression, and how its runs went. Times are in milliseconds since the epoch.
type Schedule struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Form is the operation's form, which each run starts from. Its operation is one of
	// Operations.
	Form operations.Form `json:"form"`
	// When is the cron expression.
	When      string `json:"when"`
	Paused    bool   `json:"paused"`
	CreatedAt int64  `json:"createdAt"`
	// Baselined is set for a bisync once a merge of its two folders has succeeded. Until then, a
	// run that finds no listings merges them.
	Baselined bool `json:"baselined"`

	// LastRunAt is when the last run ended, or nil before the first.
	LastRunAt *int64 `json:"lastRunAt"`
	// LastResult is how the last run ended: one of the Result constants, or "" before the first.
	LastResult string `json:"lastResult"`
	// LastError is why the last run failed. It is English inside the core, and the API gives it
	// in the app's language.
	LastError string `json:"lastError"`
	// LastTransferID is the last run's transfer. It is "" for a run that was refused before it
	// started, and for one that had nothing to do, which History doesn't keep.
	LastTransferID string `json:"lastTransferId"`
	// LastSkippedAt is a time that was skipped because the run before it was still going. It is
	// cleared when the next run starts.
	LastSkippedAt *int64 `json:"lastSkippedAt"`

	// Running is set while a run is in progress, and RunningID is its transfer once its start has
	// returned. Neither is stored.
	Running   bool   `json:"running"`
	RunningID string `json:"runningId"`
	// NextRun is the next scheduled time, or nil while the schedule is paused.
	NextRun *int64 `json:"nextRun"`
	// Warning is set by Save when a watcher already keeps a bisync's two folders the same. It is
	// not stored.
	Warning string `json:"warning,omitempty"`

	lastError i18n.Text // LastError as a translatable text
}

// local returns s with its last error in the app's language, as a page shows it.
func (s *Schedule) local() *Schedule {
	if s != nil {
		s.LastError = s.lastError.Local()
	}
	return s
}

// Input is the drawer's form, which creates or edits a schedule. An empty ID creates one.
type Input struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Form operations.Form `json:"form"`
	When string          `json:"when"`
}

// Description is what Describe says about a cron expression: its next times, or its problem.
type Description struct {
	// Next holds the next 3 times, in ms.
	Next []int64 `json:"next"`
	// Zone is the time zone's abbreviation, such as EET.
	Zone    string `json:"zone"`
	Problem string `json:"problem"`
}

const (
	ResultCompleted = "completed"
	// ResultNothing is a run that completed having changed nothing, or a Move, Delete or Purge
	// whose sources were all gone.
	ResultNothing     = "nothing"
	ResultFailed      = "failed"
	ResultStopped     = "stopped"
	ResultInterrupted = "interrupted"
)

// Operations are the operations that a schedule can run.
var Operations = []operations.Operation{
	operations.OperationCopy, operations.OperationMove, operations.OperationSync,
	operations.OperationBisync, operations.OperationDelete, operations.OperationPurge,
}
