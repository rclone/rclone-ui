package transfers

import (
	"context"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

// These are the service's types, as the pages receive them. Times are in milliseconds since the
// epoch. The transfer number shown on the pages is its Seq.

// State is the state of a transfer. Queued and running transfers are still open. The other
// states mean that the transfer has ended.
type State string

const (
	StateQueued      State = "queued"
	StateRunning     State = "running"
	StateCompleted   State = "completed"
	StateFailed      State = "failed"
	StateStopped     State = "stopped"
	StateInterrupted State = "interrupted"
	// StateDropped is never stored. transfers.changed reports it for an owned transfer whose
	// owner found its end quiet (Owner.Quiet), such as a watcher's run that changed nothing. It
	// was removed from the record instead of ended.
	StateDropped State = "dropped"
)

// OriginKind is where a transfer was started from.
type OriginKind string

const (
	// OriginPage is an operation page, the Download page, or the launcher's cleanup.
	OriginPage      OriginKind = "page"
	OriginCommander OriginKind = "commander"
	// OriginTemplate is a template's run, from its card or the launcher.
	OriginTemplate OriginKind = "template"
	// OriginWatcher is a watcher's run (core/watchers). The watcher owns the run (Owner), and a
	// retry of it is the user's own run.
	OriginWatcher OriginKind = "watcher"
	// OriginSchedule is a schedule's run (core/schedules). The schedule owns the run (Owner), and
	// a retry of it is the user's own run.
	OriginSchedule OriginKind = "schedule"
	// OriginAgent is an AI agent's run, started through the app's MCP server (core/agents). The
	// origin's name is the agent's client, such as "Claude Code".
	OriginAgent OriginKind = "agent"
)

type originKey struct{}

// WithOrigin returns a context whose transfers start with the origin o instead of a page's or
// the Commander's. The agents' server sets it around a tool's call, so that whatever the call
// starts, through any service, is recorded as the agent's. A run that belongs to a template, a
// watcher or a schedule keeps its own origin.
func WithOrigin(ctx context.Context, o Origin) context.Context {
	return context.WithValue(ctx, originKey{}, o)
}

func (k OriginKind) valid() bool {
	switch k {
	case OriginPage, OriginCommander, OriginTemplate, OriginWatcher, OriginSchedule, OriginAgent:
		return true
	}
	return false
}

// Origin records where a transfer was started from. History names it on each row, and a search
// finds its name. A retry has the origin of the transfer it retries.
type Origin struct {
	Kind OriginKind `json:"kind"`
	// ID is the template's, the watcher's or the schedule's id, and "" for any other origin.
	ID string `json:"id,omitempty"`
	// Name is the template's, the watcher's or the schedule's name when the transfer started.
	Name string `json:"name,omitempty"`
}

// Summary holds a transfer's totals when it ended, stored as final_stats. The transfer's page
// shows them, and Retry compares the error count with the number of failed files recorded.
type Summary struct {
	Bytes      int64 `json:"bytes"`
	TotalBytes int64 `json:"totalBytes"`
	Transfers  int64 `json:"transfers"`
	Checks     int64 `json:"checks"`
	Errors     int64 `json:"errors"`
	// Deletes counts the files and folders deleted, and Renames the files renamed (such as a
	// bisync's conflict loser).
	Deletes    int64 `json:"deletes"`
	Renames    int64 `json:"renames"`
	DurationMs int64 `json:"durationMs"`
}

// ChangedNothing reports whether a transfer that ended with these totals copied, deleted and
// renamed nothing. A transfer without totals changed nothing either.
func ChangedNothing(s *Summary) bool {
	return s == nil || s.Transfers == 0 && s.Deletes == 0 && s.Renames == 0
}

// Transfer is one row of the ledger, as the Transfers list, the Commander and the callbacks that
// run when a transfer ends see it.
type Transfer struct {
	ID          string               `json:"id"`
	Seq         int64                `json:"seq"`
	CreatedAt   int64                `json:"createdAt"`
	StartedAt   *int64               `json:"startedAt"`
	EndedAt     *int64               `json:"endedAt"`
	State       State                `json:"state"`
	Operation   operations.Operation `json:"operation"`
	Sources     []string             `json:"sources"`
	Destination string               `json:"destination"`
	IsDryRun    bool                 `json:"isDryRun"`
	Origin      Origin               `json:"origin"`
	// Group is the stats group that the transfer's job ran in (transfer/<id>).
	Group string `json:"-"`
	// Error is why the transfer failed. It is English inside the core, and the API gives it in
	// the app's language. ErrorText gives it as a translatable text.
	Error string `json:"error"`
	// Stats holds the totals at the end. It is nil while the transfer runs, and when it ended
	// without any numbers.
	Stats *Summary `json:"stats"`
	// Live is the latest progress of a running transfer (the payload of transfers.progress). It
	// lets a page show numbers before the next event arrives.
	Live *bus.TransferProgress `json:"live"`

	// RetryOf is the id of the transfer that this one retries. Detail adds its number.
	RetryOf string `json:"-"`
	// Resume is set when a restart for an update marked the transfer to be started again.
	Resume bool `json:"-"`

	saved string // Error in the form that the ledger saves it (i18n.Save)
}

// ErrorText returns the transfer's error as a translatable text: Error in English, which is shown
// in the app's language. rclone's own errors stay in rclone's words.
func (t Transfer) ErrorText() i18n.Text {
	if t.saved != "" {
		return i18n.Saved(t.saved)
	}
	return i18n.Saved(t.Error)
}

func (t Transfer) WithError(err error) Transfer {
	t.Error, t.saved = err.Error(), i18n.Save(err)
	return t
}

func (t Transfer) WithErrorText(text i18n.Text) Transfer {
	t.Error, t.saved = text.String(), saveText(text)
	return t
}

// SavedError returns the transfer's error in the form to save (see saveText), for a watcher's or
// a schedule's last error.
func (t Transfer) SavedError() string {
	if t.saved != "" {
		return t.saved
	}
	return t.Error
}

// local returns t as a page sees it, with its error in the app's language.
func (t Transfer) local() Transfer {
	t.Error = t.ErrorText().Local()
	return t
}

// Ref refers to another transfer by its id and number.
type Ref struct {
	ID    string `json:"id"`
	Seq   int64  `json:"seq"`
	State State  `json:"state"`
}

// Detail is the transfer as its own page shows it. Besides the row, it holds the transfer it
// retries, the retries made of it, its preset (used by Duplicate), the errors that are not tied
// to a file, and how many of its failures can be retried.
type Detail struct {
	Transfer `json:"transfer"`
	RetryOf  *Ref             `json:"retryOf"`
	Retries  []Ref            `json:"retries"`
	Preset   *operations.Form `json:"preset"`
	General  []GeneralError   `json:"general"`
	// Retryable is how many items the retry page offers. When it is 0, there is no Retry button.
	Retryable int `json:"retryable"`
}

// Outcome is how a file ended in a transfer.
type Outcome string

const (
	OutcomeTransferred Outcome = "transferred"
	OutcomeFailed      Outcome = "failed"
	OutcomeChecked     Outcome = "checked"
)

// File is a file that a transfer has finished with, stored in transfer_files.
type File struct {
	// Cursor is the Before value for the next page, when this is the last row shown.
	Cursor  string  `json:"cursor"`
	Outcome Outcome `json:"outcome"`
	SrcFs   string  `json:"srcFs"`
	Name    string  `json:"name"`
	// Step is the index of the plan step that the file belongs to, when known.
	Step        *int   `json:"step"`
	What        string `json:"what"`
	DstFs       string `json:"dstFs"`
	Size        int64  `json:"size"`
	Bytes       int64  `json:"bytes"`
	Error       string `json:"error"`
	CompletedAt int64  `json:"completedAt"`
}

// FilesPage is one page of a transfer's files with a single outcome, newest first.
type FilesPage struct {
	Items []File `json:"items"`
	More  bool   `json:"more"`
	// Total is the number of files with this outcome that the ledger stores for the transfer.
	Total int `json:"total"`
}

type EndedPage struct {
	Items []Transfer `json:"items"`
	More  bool       `json:"more"`
}

// GeneralError is an error that is not tied to a single file. It belongs to a whole step, to the
// job, or to the transfer's record itself.
type GeneralError struct {
	// Subject is the label of the step that the error is about. It is "" when the error applies
	// to the whole transfer.
	Subject string `json:"subject"`
	// Error is English inside the core, and the API gives it in the app's language.
	Error string `json:"error"`

	text i18n.Text // Error as a translatable text
}

func generalError(subject string, text i18n.Text) GeneralError {
	return GeneralError{Subject: subject, Error: text.String(), text: text}
}

// ErrorText returns the error as a translatable text, whose String is English. The API gives
// Error in the app's language, and the agents' server reads this instead, because a model reads
// it.
func (g GeneralError) ErrorText() i18n.Text {
	if !g.text.IsZero() {
		return g.text
	}
	return i18n.Saved(g.Error)
}

func (g GeneralError) local() GeneralError {
	if !g.text.IsZero() {
		g.Error = g.text.Local()
	}
	return g
}

// RetryItem is one part of an ended transfer that can be retried. It is either a file that failed
// inside a folder, or a step that failed as a whole (kind "step").
type RetryItem struct {
	// Key identifies the item when the page calls Retry: [src_fs, name].
	Key   [2]string `json:"key"`
	Kind  string    `json:"kind"`
	Label string    `json:"label"`
	// Source is the full source path, which is recorded on the retry.
	Source string `json:"source"`
	// Error is English inside the core, and the API gives it in the app's language.
	Error string `json:"error"`
	What  string `json:"what"`
	Step  *int   `json:"step"`
	DstFs string `json:"dstFs"`

	step operations.Step // the step that retries it
	text i18n.Text       // Error as a translatable text, for a step's error
}

// Retryable is the list shown on the retry page.
type Retryable struct {
	Items   []RetryItem    `json:"items"`
	General []GeneralError `json:"general"`
	// Refused explains why this build can't run the retry, because its plan fails the check
	// that every start makes. It is shown instead of Items, and is "" when the retry can run. It
	// is English inside the core, and the API gives it in the app's language.
	Refused string `json:"refused"`

	refused i18n.Text // Refused as a translatable text
}

func (r Retryable) local() Retryable {
	r.Refused = r.refused.Local()
	items := make([]RetryItem, len(r.Items))
	for i, it := range r.Items {
		if !it.text.IsZero() {
			it.Error = it.text.Local()
		}
		items[i] = it
	}
	r.Items = items
	r.General = localGeneral(r.General)
	return r
}

func localGeneral(errors []GeneralError) []GeneralError {
	out := make([]GeneralError, len(errors))
	for i, g := range errors {
		out[i] = g.local()
	}
	return out
}
