package transfers

import (
	"reflect"
	"testing"

	"github.com/rclone/rclone-ui/core/operations"
)

// The retry plan. A failed file is matched to the step it failed in by the Fs names that rclone
// reports (transfer_files.input), and a step that failed as a whole is retried as it was.

var retryConfig = operations.Options{"ignore_existing": "true"}

func failedTransfer(name, srcFs, dstFs string, step int) failedFile {
	return failedFile{srcFs: srcFs, name: name, what: "transferring", dstFs: dstFs,
		err: "couldn't copy " + name + ": permission denied", step: &step}
}

func folderCopy(errs []string, failed ...failedFile) retrySource {
	src := retrySource{
		plan: operations.Plan{V: 1, Steps: []operations.Step{
			{Op: operations.OpCopy, Src: ":local:/data/photos/", Dst: "gdrive:backup/photos", CreateEmptySrcDirs: true},
		}, Config: retryConfig, Filter: operations.Options{"max_size": "10Mi"}},
		failed: failed,
	}
	if errs != nil {
		src.out = &outcome{V: 1, Errors: errs}
	}
	return src
}

type planned struct{ kind, label, error string }

func plannedOf(items []RetryItem) []planned {
	out := []planned{}
	for _, it := range items {
		out = append(out, planned{it.Kind, it.Label, it.Error})
	}
	return out
}

func TestRetryPlanFileInsideAFolder(t *testing.T) {
	src := folderCopy([]string{"couldn't copy a.jpg"},
		failedTransfer("2024/a.jpg", ":local:/data/photos", "gdrive:backup/photos", 0))
	items := retryPlan(src)
	if len(items) != 1 || items[0].Kind != "file" || items[0].Label != "2024/a.jpg" {
		t.Fatalf("items %+v", items)
	}
	want := operations.Step{Op: operations.OpCopyFile, Src: ":local:/data/photos/", SrcRemote: "2024/a.jpg",
		Dst: "gdrive:backup/photos", DstRemote: "2024/a.jpg"}
	if items[0].step != want {
		t.Errorf("step %+v, want %+v", items[0].step, want)
	}
	if items[0].Source != ":local:/data/photos/2024/a.jpg" || items[0].Key != [2]string{":local:/data/photos", "2024/a.jpg"} {
		t.Errorf("source %q key %v", items[0].Source, items[0].Key)
	}
	if items[0].Step == nil || *items[0].Step != 0 {
		t.Errorf("input index %v", items[0].Step)
	}
	// A selection becomes one plan with the original's options. The filter applies only to
	// folder steps, so not to this file.
	got := retryOf(items, src.plan)
	if !reflect.DeepEqual(got.Steps, []operations.Step{want}) || !reflect.DeepEqual(got.Config, retryConfig) ||
		got.Steps[0].Folder() || got.Check() != nil {
		t.Errorf("plan %+v", got)
	}
}

func TestRetryPlanMoveAndNonTransfers(t *testing.T) {
	gone := failedTransfer("gone.jpg", ":local:/data/photos", "gdrive:backup/photos", 0)
	gone.what = "deleting"
	same := failedTransfer("same.jpg", ":local:/data/photos", "gdrive:backup/photos", 0)
	same.what = "checking"
	src := folderCopy([]string{"x"}, failedTransfer("a.jpg", ":local:/data/photos", "gdrive:backup/photos", 0), gone, same)
	src.plan.Steps[0].Op = operations.OpMove
	items := retryPlan(src)
	if len(items) != 1 || items[0].Label != "a.jpg" || items[0].step.Op != operations.OpMoveFile {
		t.Errorf("items %+v", items)
	}
}

func TestRetryPlanStepFailedAsAWhole(t *testing.T) {
	copyfile := operations.Step{Op: operations.OpCopyFile, Src: "gdrive:", SrcRemote: "docs/missing.txt",
		Dst: ":local:/backup", DstRemote: "missing.txt"}
	download := operations.Step{Op: operations.OpCopyURL, Dst: ":local:/dl", DstRemote: "x.zip", URL: "https://e/x.zip"}
	src := retrySource{
		plan: operations.Plan{V: 1, Steps: []operations.Step{
			{Op: operations.OpCopy, Src: "/data/ok/", Dst: "/backup/ok"},
			copyfile,
			{Op: operations.OpCopy, Src: "/data/never/", Dst: "/backup/never"},
			download,
		}},
		out: &outcome{V: 1, Errors: []string{"", "object not found", "directory not found", "404"}},
		// A failed file in a step that did not fail doesn't count as a failure of that step. For
		// example, rclone may have retried it successfully.
		failed: []failedFile{failedTransfer("late.txt", "/data/ok", "/backup/ok", 0)},
	}
	items := retryPlan(src)
	want := []planned{
		{"step", "docs/missing.txt", "object not found"},
		{"step", "/data/never/", "directory not found"},
		{"step", "x.zip", "404"},
	}
	if got := plannedOf(items); !reflect.DeepEqual(got, want) {
		t.Fatalf("plan %+v, want %+v", got, want)
	}
	if items[0].step != copyfile || items[0].Key != [2]string{"gdrive:", "docs/missing.txt"} || items[0].Source != "gdrive:docs/missing.txt" {
		t.Errorf("step item %+v", items[0])
	}
	if items[1].Key != [2]string{"/data/never/", ""} || *items[1].Step != 2 {
		t.Errorf("folder item key %v input %v", items[1].Key, items[1].Step)
	}
	if items[2].step != download || items[2].Key != [2]string{":local:/dl", "x.zip"} {
		t.Errorf("download item %+v", items[2])
	}
}

func TestRetryPlanSeveralFolders(t *testing.T) {
	src := retrySource{
		plan: operations.Plan{V: 1, Steps: []operations.Step{
			{Op: operations.OpCopy, Src: "gdrive,chunk_size='8M':a/", Dst: "/backup/a"},
			{Op: operations.OpCopy, Src: "gdrive,chunk_size='8M':b/", Dst: "/backup/b"},
		}},
		out: &outcome{V: 1, Errors: []string{"x", "y"}},
		failed: []failedFile{
			// rclone names an overridden remote with a hash of its overrides.
			failedTransfer("readme.txt", "gdrive{AbCdE}:b", "/backup/b", 1),
			{srcFs: "elsewhere:", name: "stray.txt", what: "transferring", err: "no"},
		},
	}
	items := retryPlan(src)
	want := []planned{
		{"step", "gdrive,chunk_size='8M':a/", "x"},
		{"file", "readme.txt", "couldn't copy readme.txt: permission denied"},
	}
	if got := plannedOf(items); !reflect.DeepEqual(got, want) {
		t.Fatalf("plan %+v, want %+v", got, want)
	}
	if items[1].step.Src != "gdrive,chunk_size='8M':b/" || items[1].step.Dst != "/backup/b" {
		t.Errorf("file item %+v", items[1].step)
	}
}

func TestRetryPlanSync(t *testing.T) {
	src := retrySource{
		plan: operations.Plan{V: 1, Steps: []operations.Step{{Op: operations.OpSync, Src: "/data/site", Dst: "s3:bucket/site"}},
			Config: retryConfig},
		out:    &outcome{V: 1, Errors: []string{"1 file failed"}},
		failed: []failedFile{{srcFs: "/data/site", name: "index.html", what: "transferring", err: "denied"}},
	}
	items := retryPlan(src)
	want := operations.Step{Op: operations.OpCopyFile, Src: "/data/site", SrcRemote: "index.html",
		Dst: "s3:bucket/site", DstRemote: "index.html"}
	if len(items) != 1 || items[0].step != want || items[0].Step != nil {
		t.Fatalf("items %+v", items)
	}
	if p := retryOf(items, src.plan); p.Whole() || !reflect.DeepEqual(p.Config, retryConfig) {
		t.Errorf("a sync's retry %+v", p)
	}
	// Bisync keeps its own record of both sides, so the way to retry it is to run it again.
	src.plan.Steps[0].Op = operations.OpBisync
	if items := retryPlan(src); len(items) != 0 {
		t.Errorf("bisync plan %+v", items)
	}
}

// rclone counts each error once. A folder step with more errors than failed files had failures
// that were never seen, so it is retried whole. With no outcome (a stopped transfer), no step is
// known to have failed as a whole, and the files that were seen are what can be retried.
func TestRetryPlanMissedFailures(t *testing.T) {
	failed := failedTransfer("a.jpg", ":local:/data/photos", "gdrive:backup/photos", 0)
	for _, tc := range []struct {
		name   string
		errs   []string
		errors int64
		want   []planned
	}{
		{"every failure seen", []string{"x"}, 1, []planned{{"file", "a.jpg", failed.err}}},
		{"failures missed", []string{"x"}, 3, []planned{{"step", ":local:/data/photos/", "x"}}},
		{"stopped", nil, 3, []planned{{"file", "a.jpg", failed.err}}},
	} {
		src := folderCopy(tc.errs, failed)
		src.errors = tc.errors
		if got := plannedOf(retryPlan(src)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestRetryPlanStoppedOrderAndHistory(t *testing.T) {
	// With no outcome (a stopped transfer's outcome is not read), the files collected while it
	// ran are retried. A file whose step is unknown goes to the only folder.
	stray := failedTransfer("b.jpg", "/elsewhere", "", 0)
	stray.step = nil
	stopped := folderCopy(nil, failedTransfer("a.jpg", ":local:/data/photos", "gdrive:backup/photos", 0), stray)
	if got := plannedOf(retryPlan(stopped)); len(got) != 2 || got[0].label != "a.jpg" || got[1].label != "b.jpg" {
		t.Errorf("stopped plan %+v", got)
	}
	// They are listed by name, not in the order they finished.
	src := folderCopy([]string{"x"},
		failedTransfer("Porto/b.jpg", ":local:/data/photos", "gdrive:backup/photos", 0),
		failedTransfer("Lisbon/z.jpg", ":local:/data/photos", "gdrive:backup/photos", 0),
		failedTransfer("Lisbon/a.jpg", ":local:/data/photos", "gdrive:backup/photos", 0))
	var labels []string
	for _, it := range retryPlan(src) {
		labels = append(labels, it.Label)
	}
	if !reflect.DeepEqual(labels, []string{"Lisbon/a.jpg", "Lisbon/z.jpg", "Porto/b.jpg"}) {
		t.Errorf("labels %v", labels)
	}
	// A plan that this build can't read (from a newer build) leaves nothing to retry. The
	// transfer is only history.
	old := folderCopy([]string{"x"}, failedTransfer("a.jpg", ":local:/data/photos", "", 0))
	old.plan = operations.Plan{}
	if items := retryPlan(old); len(items) != 0 {
		t.Errorf("an old transfer's plan %+v", items)
	}
}
