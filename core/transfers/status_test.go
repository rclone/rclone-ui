package transfers

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/rclone/rclone-ui/core/operations"
)

// copyPlan is a plan whose step labels are the subjects of the tests' errors.
func copyPlan() operations.Plan {
	return operations.Plan{V: 1, Steps: []operations.Step{
		{Op: operations.OpCopy, Src: "/data/src/", Dst: "/data/dst"},
		{Op: operations.OpCopyFile, Src: "/data/", SrcRemote: "missing.txt", Dst: "/b", DstRemote: "missing.txt"},
		{Op: operations.OpCopyFile, Src: "/data/", SrcRemote: "ok.txt", Dst: "/b", DstRemote: "ok.txt"},
	}}
}

func TestOutcome(t *testing.T) {
	p := copyPlan()
	for _, tc := range []struct {
		name, jobErr string
		errs         []string
		state        State
		err, launch  string
	}{
		{name: "ok", errs: []string{"", "", ""}, state: StateCompleted},
		{name: "job error", jobErr: "max_size: bad", errs: []string{"", "", ""}, state: StateFailed,
			err: "max_size: bad", launch: "max_size: bad"},
		{name: "a batch succeeds as a job while a step failed", errs: []string{"", "object not found", ""},
			state: StateFailed, err: "1 of 3 operations failed"},
		{name: "a batch with nothing left standing failed its launch",
			errs:  []string{"directory not found", "object not found", "x"},
			state: StateFailed, err: "3 of 3 operations failed",
			launch: "/data/src/: directory not found\nmissing.txt: object not found\nok.txt: x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := outcome{V: 1, Errors: tc.errs}
			state, err := stateOf(words(tc.jobErr), out)
			if state != tc.state || err.String() != tc.err {
				t.Errorf("outcome %s %q, want %s %q", state, err, tc.state, tc.err)
			}
			if got := launchError(tc.jobErr, p, out); got != tc.launch {
				t.Errorf("launch error %q, want %q", got, tc.launch)
			}
			// The row's error is the job's own, unless it is the ledger's summary.
			if got := jobErrorOf(err, out).String(); got != tc.jobErr {
				t.Errorf("job error of %q = %q, want %q", err, got, tc.jobErr)
			}
		})
	}
	// Anything that isn't in this build's format counts as no outcome: an empty value, a newer
	// build's outcome, or something that isn't an outcome at all.
	for _, raw := range []string{"", `{"v":99,"errors":["x"]}`, `{}`, "not json"} {
		if _, ok := parseOutcome([]byte(raw)); ok {
			t.Errorf("%q read as an outcome", raw)
		}
	}
}

func TestGeneralErrors(t *testing.T) {
	const locked = "couldn't copy from /data/src/sub/locked.txt to /data/dst/sub/locked.txt.c4bd8624.partial: errno -1"
	batch := &outcome{V: 1, Errors: []string{locked, "object not found", ""}}
	sync := operations.Plan{V: 1, Steps: []operations.Step{{Op: operations.OpSync, Src: "/data/site", Dst: "s3:b"}}}
	for _, tc := range []struct {
		name, recorded string
		plan           operations.Plan
		out            *outcome
		shown          []string
		want           []GeneralError
	}{
		{"a file's error is not repeated", "2 of 3 operations failed", copyPlan(), batch, []string{locked},
			[]GeneralError{{Subject: "missing.txt", Error: "object not found"}}},
		{"a file kept by nobody: shown by its folder", "2 of 3 operations failed", copyPlan(), batch, nil,
			[]GeneralError{{Subject: "/data/src/", Error: locked}, {Subject: "missing.txt", Error: "object not found"}}},
		{"a sync's error a file carries", locked, sync, &outcome{V: 1, Errors: []string{locked}}, []string{locked}, []GeneralError{}},
		{"a sync's error no file carries: said once", "directory not found", sync,
			&outcome{V: 1, Errors: []string{"directory not found"}}, nil, []GeneralError{{Error: "directory not found"}}},
		{"no outcome: the record speaks", "the app stopped", copyPlan(), nil, nil, []GeneralError{{Error: "the app stopped"}}},
		{"no outcome, no error", "", copyPlan(), nil, nil, []GeneralError{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shown := map[string]bool{}
			for _, s := range tc.shown {
				shown[s] = true
			}
			if got := englishGeneral(generalErrors(words(tc.recorded), tc.plan, tc.out, shown)); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestResumable(t *testing.T) {
	for _, tc := range []struct {
		operation operations.Operation
		origin    OriginKind
		want      bool
	}{
		{"copy", OriginPage, true},
		{"move", OriginCommander, true},
		{"sync", OriginTemplate, true},
		{"bisync", OriginPage, false},
		{"copy", OriginWatcher, false},
		{"copy", OriginSchedule, false},
		{"copy", "", false},
	} {
		if got := resumable(tc.operation, tc.origin); got != tc.want {
			t.Errorf("resumable(%s, %s) = %v", tc.operation, tc.origin, got)
		}
	}
	// A transfer as the busy check sees it. Only an open one starts again. One that is being
	// stopped (claimed, but without its end yet) won't be marked.
	ended := int64(2)
	for _, tc := range []struct {
		name string
		t    Transfer
		want bool
	}{
		{"a running page copy", Transfer{State: StateRunning, Operation: "copy", Origin: Origin{Kind: OriginPage}}, true},
		{"the same, being stopped", Transfer{State: StateStopped, Operation: "copy", Origin: Origin{Kind: OriginPage}}, false},
		{"the same, interrupted", Transfer{State: StateInterrupted, Operation: "copy", Origin: Origin{Kind: OriginPage}, EndedAt: &ended}, false},
	} {
		if got := Resumable(tc.t); got != tc.want {
			t.Errorf("%s: Resumable %v", tc.name, got)
		}
	}
}

// A transfer's totals are stored as JSON (final_stats). Every later build reads them back, and
// Retry reads the error count, so their keys must not change.
func TestSummaryJSON(t *testing.T) {
	raw, err := json.Marshal(Summary{Bytes: 1, TotalBytes: 2, Transfers: 3, Checks: 4, Errors: 5, Deletes: 7, Renames: 8, DurationMs: 6})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"bytes":1,"totalBytes":2,"transfers":3,"checks":4,"errors":5,"deletes":7,"renames":8,"durationMs":6}`; string(raw) != want {
		t.Errorf("final_stats %s, want %s", raw, want)
	}
}

// A dry run's preset loses its dry_run and keeps the rest. The preset itself doesn't change.
func TestWithoutDryRun(t *testing.T) {
	for in, want := range map[string]string{
		`{"operation":"copy","copy":{"options":{"config":{"dry_run":true,"x":1}}}}`: `{"operation":"copy","copy":{"options":{"config":{"x":1}}}}`,
		`{"operation":"sync","sync":{"options":{"config":{"x":1}}}}`:                `{"operation":"sync","sync":{"options":{"config":{"x":1}}}}`,
		`{"operation":"copy"}`: `{"operation":"copy"}`,
		`{"operation":"delete-folder","deleteFolder":{"path":"/x"}}`: `{"operation":"delete-folder","deleteFolder":{"path":"/x"}}`,
	} {
		var preset operations.Form
		if err := json.Unmarshal([]byte(in), &preset); err != nil {
			t.Fatal(err)
		}
		if got := string(mustJSON(t, withoutDryRun(&preset))); got != want {
			t.Errorf("withoutDryRun(%s) = %s, want %s", in, got, want)
		}
		if got := string(mustJSON(t, preset)); got != in {
			t.Errorf("withoutDryRun(%s) changed it to %s", in, got)
		}
	}
	if withoutDryRun(nil) != nil {
		t.Error("no preset")
	}
}

// englishGeneral returns errors as the tests write them: their subjects and their English
// messages.
func englishGeneral(errors []GeneralError) []GeneralError {
	out := make([]GeneralError, len(errors))
	for i, g := range errors {
		out[i] = GeneralError{Subject: g.Subject, Error: g.Error}
	}
	return out
}
