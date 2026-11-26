package transfers

import (
	"errors"
	"testing"

	"github.com/rclone/rclone/fs/accounting"
)

func TestRowOutcome(t *testing.T) {
	none := func(accounting.TransferSnapshot) *int { return nil }
	for _, c := range []struct {
		what    string
		checked bool
		err     error
		want    Outcome
	}{
		{"transferring", false, nil, OutcomeTransferred},
		{"transferring", false, errors.New("boom"), OutcomeFailed},
		{"checking", true, nil, OutcomeChecked},
		{"hashing", true, nil, OutcomeChecked},
		{"listing", true, nil, OutcomeChecked},
		{"listing file - Path1", true, nil, OutcomeChecked},
		{"listing file - Path2", true, nil, OutcomeChecked},
		{"listing dir - Path1", true, nil, OutcomeChecked},
		{"computing hash with --download-hash", true, nil, OutcomeChecked},
		{"importing", true, nil, OutcomeChecked},
		{"moving", true, nil, OutcomeTransferred},
		{"deleting", true, nil, OutcomeTransferred},
		{"renaming", true, nil, OutcomeTransferred},
		{"merging", true, nil, OutcomeTransferred},
		{"listing file - Path1", true, errors.New("boom"), OutcomeFailed},
	} {
		got := rowOf(accounting.TransferSnapshot{Name: "a", What: c.what, Checked: c.checked, Error: c.err}, none)
		if got.outcome != c.want {
			t.Errorf("%q (checked %v, error %v): %s, want %s", c.what, c.checked, c.err, got.outcome, c.want)
		}
	}
}
