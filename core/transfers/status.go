package transfers

import (
	"encoding/json"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

// These functions work out how a job ended. They have no side effects, and both the end handler
// and the launch check use them.

// outcomeVersion is the version of the outcome this build writes in job_output.
const outcomeVersion = 1

// outcome is what the ledger stores about a job's end (job_output): each step's error in the
// plan's order, with "" for a step that did not fail. The job of a batch succeeds even when some
// of its steps fail. Each error is saved with i18n.Save, so that a step's error that is the
// core's own is shown in the language the app has when it is read.
type outcome struct {
	V      int      `json:"v"`
	Errors []string `json:"errors"`
}

func outcomeOf(rec *operations.Record) outcome {
	out := outcome{V: outcomeVersion, Errors: []string{}}
	for _, s := range rec.Steps() {
		out.Errors = append(out.Errors, i18n.Save(s.Err))
	}
	return out
}

// parseOutcome reads job_output. It returns false when there is none, or when it isn't in this
// build's format.
func parseOutcome(raw []byte) (outcome, bool) {
	var out outcome
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out.V != outcomeVersion {
		return outcome{}, false
	}
	return out, true
}

// words returns text that is shown as it is in every language, such as rclone's own error, as a
// Text. A saved Text reads back as itself.
func words(text string) i18n.Text { return i18n.Saved(text) }

// saveText returns text in the form to save. rclone's own error, which is only words, is saved as
// its words, as i18n.Save saves it.
func saveText(text i18n.Text) string { return i18n.SaveText(text) }

// textOf returns err's message as a Text: translatable when it is the core's own, and err's
// words otherwise.
func textOf(err error) i18n.Text { return i18n.Saved(i18n.Save(err)) }

// failure is a step that failed: its label and its error.
type failure struct {
	label string
	err   i18n.Text
}

// failuresOf returns a plan's failed steps. Each is labeled by its file or, for a folder, by the
// place it is read from.
func failuresOf(p operations.Plan, out outcome) []failure {
	var fs []failure
	for i, e := range out.Errors {
		if e == "" {
			continue
		}
		label := "unknown"
		if i < len(p.Steps) {
			label = p.Steps[i].Label()
		}
		fs = append(fs, failure{label, words(e)})
	}
	return fs
}

func failedSteps(out outcome) int {
	n := 0
	for _, e := range out.Errors {
		if e != "" {
			n++
		}
	}
	return n
}

// summaryError is the error recorded for a batch that has failed steps but no error of its own.
// It is the zero Text when no step failed.
func summaryError(out outcome) i18n.Text {
	n := failedSteps(out)
	if n == 0 {
		return i18n.Text{}
	}
	// i18n: A transfer's error when some of its steps failed: how many failed, of how many. The plural form follows the first number. In English, "operations" is plural in both forms.
	return i18n.MN("%d of %d operations failed", "%d of %d operations failed", n, n, len(out.Errors))
}

// stateOf returns how a finished job ended. The job fails with its own error, or with a summary
// when any step failed.
func stateOf(jobErr i18n.Text, out outcome) (State, i18n.Text) {
	if jobErr.IsZero() {
		jobErr = summaryError(out)
	}
	if !jobErr.IsZero() {
		return StateFailed, jobErr
	}
	return StateCompleted, i18n.Text{}
}

// launchError is the error that Start returns when its job ended within the launch check. It is
// the job's own error or, for a batch whose steps all failed, each step's error on its own line.
func launchError(jobErr string, p operations.Plan, out outcome) string {
	if jobErr != "" {
		return jobErr
	}
	fs := failuresOf(p, out)
	if len(fs) == 0 || len(fs) != len(out.Errors) {
		return ""
	}
	lines := make([]string, len(fs))
	for i, f := range fs {
		lines[i] = f.label + ": " + f.err.String()
	}
	return strings.Join(lines, "\n")
}

// jobErrorOf returns the job's own error from a row. That is the recorded error, unless it is the
// summary that the ledger wrote for failed steps.
func jobErrorOf(recorded i18n.Text, out outcome) i18n.Text {
	if !recorded.IsZero() && recorded.String() == summaryError(out).String() {
		return i18n.Text{}
	}
	return recorded
}

// generalErrors returns the errors that don't belong to a file. With no outcome, that is the
// record's own error. Otherwise it is the job's error and the error of every failed step, minus
// those that a failed file's row already shows word for word. When a step's error is the same as
// the job's (as with a sync), it is shown once, as the job's error.
func generalErrors(recorded i18n.Text, p operations.Plan, out *outcome, failedErrors map[string]bool) []GeneralError {
	if out == nil {
		if recorded.IsZero() {
			return []GeneralError{}
		}
		return []GeneralError{generalError("", recorded)}
	}
	var all []GeneralError
	jobErr := jobErrorOf(recorded, *out)
	if !jobErr.IsZero() {
		all = append(all, generalError("", jobErr))
	}
	for _, f := range failuresOf(p, *out) {
		if f.err.String() != jobErr.String() {
			all = append(all, generalError(f.label, f.err))
		}
	}
	general := []GeneralError{}
	for _, g := range all {
		if !failedErrors[g.Error] {
			general = append(general, g)
		}
	}
	return general
}
