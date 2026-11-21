package rclone

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
)

func groups(t *testing.T) []string {
	t.Helper()
	out, _, err := Call(context.Background(), "core/group-list", nil, CallOpts{})
	if err != nil {
		t.Fatal(err)
	}
	return slices.Clone(out["groups"].([]string))
}

func TestCall(t *testing.T) {
	ctx := context.Background()

	out, job, err := Call(ctx, "/rcui-test/echo", rc.Params{"a": 1}, CallOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if out["in"].(rc.Params)["a"] != 1 || job == nil || out["jobid"] != job.ID {
		t.Errorf("out %v job %v", out, job)
	}
	// The job's own group is deleted after a sync call.
	if g := out["group"].(string); g != job.Group || slices.Contains(groups(t), g) {
		t.Errorf("implicit group %q left behind (groups %v)", g, groups(t))
	}

	if _, _, err := Call(ctx, "nope/nothing", nil, CallOpts{}); err == nil || err.Error() != `couldn't find method "nope/nothing"` {
		t.Errorf("unknown path: %v", err)
	}
	if _, _, err := Call(ctx, "rcui-test/fail", nil, CallOpts{}); err == nil || err.Error() != errFromRclone.Error() {
		t.Errorf("error text changed: %v", err)
	}

	// _config reaches the job (calling Fn directly would ignore it).
	out, _, err = Call(ctx, "rcui-test/echo", rc.Params{"_config": `{"DryRun": true}`}, CallOpts{})
	if err != nil || out["dryRun"] != true {
		t.Errorf("_config: %v %v", out, err)
	}
	in := rc.Params{"x": 1}
	if _, _, err := Call(ctx, "rcui-test/echo", in, CallOpts{Group: "ui/test/g", Async: false}); err != nil {
		t.Fatal(err)
	}
	if len(in) != 1 {
		t.Errorf("Call changed the caller's params: %v", in)
	}
}

func TestCallGroup(t *testing.T) {
	ctx := context.Background()
	g := UIGroup("list", "abc")
	if g != "ui/list/abc" {
		t.Fatalf("UIGroup = %q", g)
	}
	out, job, err := Call(ctx, "rcui-test/echo", nil, CallOpts{Group: g})
	if err != nil {
		t.Fatal(err)
	}
	if out["group"] != g || job.Group != g {
		t.Errorf("group %v / %v, want %s", out["group"], job.Group, g)
	}
	if !slices.Contains(groups(t), g) {
		t.Fatalf("group %s not kept for its caller", g)
	}
	DeleteGroup(ctx, g)
	if slices.Contains(groups(t), g) {
		t.Errorf("group %s not deleted", g)
	}
}

func TestCallCancelledWithItsCaller(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	_, _, err := Call(ctx, "rcui-test/wait", nil, CallOpts{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want the caller's cancellation", err)
	}
}

func TestCallAsync(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	out, job, err := Call(ctx, "rcui-test/wait", nil, CallOpts{Async: true, Group: "transfer/t1"})
	if err != nil {
		t.Fatal(err)
	}
	if out["jobid"] != job.ID || job.Group != "transfer/t1" {
		t.Errorf("out %v group %s", out, job.Group)
	}
	cancel() // an async job runs on its own context
	time.Sleep(20 * time.Millisecond)
	done := make(chan struct{})
	job.OnFinish(func() { close(done) })
	select {
	case <-done:
		t.Fatal("the async job ended with its caller's context")
	default:
	}
	job.Stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the job did not stop")
	}
	DeleteGroup(context.Background(), "transfer/t1")
}

// TestRun checks that fn runs as a job, in its stats group, marked as an rc request, and that a
// fatal rclone error becomes the job's error instead of exiting the process.
func TestRun(t *testing.T) {
	ctx := context.Background()
	var group string
	var marked bool
	job, err := Run(ctx, CallOpts{Group: UIGroup("run", "a")}, func(ctx context.Context) error {
		group, _ = accounting.StatsGroupFromContext(ctx)
		marked = fs.IsRCRequest(ctx)
		return errFromRclone
	})
	if err != errFromRclone || job == nil || group != "ui/run/a" || !marked {
		t.Fatalf("err %v job %v group %q marked %v", err, job, group, marked)
	}
	DeleteGroup(ctx, group)

	_, err = Run(ctx, CallOpts{}, func(ctx context.Context) error {
		fs.Fatalf(nil, "a backend gave up")
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "a backend gave up") {
		t.Fatalf("a fatal error: %v", err)
	}
}
