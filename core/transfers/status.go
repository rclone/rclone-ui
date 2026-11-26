package transfers

import (
	"encoding/json"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

const outcomeVersion = 1

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

func parseOutcome(raw []byte) (outcome, bool) {
	var out outcome
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out.V != outcomeVersion {
		return outcome{}, false
	}
	return out, true
}

func words(text string) i18n.Text { return i18n.Saved(text) }

func saveText(text i18n.Text) string { return i18n.SaveText(text) }

func textOf(err error) i18n.Text { return i18n.Saved(i18n.Save(err)) }

type failure struct {
	label string
	err   i18n.Text
}

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

func summaryError(out outcome) i18n.Text {
	n := failedSteps(out)
	if n == 0 {
		return i18n.Text{}
	}
	// i18n: A transfer's error when some of its steps failed: how many failed, of how many. The plural form follows the first number. In English, "operations" is plural in both forms.
	return i18n.MN("%d of %d operations failed", "%d of %d operations failed", n, n, len(out.Errors))
}

func stateOf(jobErr i18n.Text, out outcome) (State, i18n.Text) {
	if jobErr.IsZero() {
		jobErr = summaryError(out)
	}
	if !jobErr.IsZero() {
		return StateFailed, jobErr
	}
	return StateCompleted, i18n.Text{}
}

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

func jobErrorOf(recorded i18n.Text, out outcome) i18n.Text {
	if !recorded.IsZero() && recorded.String() == summaryError(out).String() {
		return i18n.Text{}
	}
	return recorded
}

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
