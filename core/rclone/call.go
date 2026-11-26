package rclone

import (
	"context"
	"fmt"
	"maps"
	"strings"

	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fs/rc/jobs"
)

type CallOpts struct {
	Group string
	Async bool
}

// Run runs fn as an rclone job. Everything that reaches an Fs runs this way, because
// jobs.NewJob gives the work several protections:
//   - A fatal rclone error (fs.Fatalf) becomes a recovered panic in the job instead of
//     exiting the process.
//   - The context is marked as an rc request, so the global.* keys in a connection string
//     apply only to that remote.
//   - The Fs cache keeps the Fs values the job uses until the job ends.
//   - The work is counted in the job's stats group.
//
// A sync run uses ctx, so cancelling the caller cancels the run. An async run returns at once
// and runs on its own context, so fn must add its own config and filters (fs.AddConfig,
// filter.ReplaceConfig).
func Run(ctx context.Context, o CallOpts, fn func(ctx context.Context) error) (*jobs.Job, error) {
	job, _, err := runJob(ctx, func(ctx context.Context, _ rc.Params) (rc.Params, error) {
		return nil, fn(ctx)
	}, nil, o)
	return job, err
}

func Call(ctx context.Context, path string, in rc.Params, o CallOpts) (rc.Params, *jobs.Job, error) {
	path = strings.TrimPrefix(path, "/")
	call := rc.Calls.Get(path)
	if call == nil {
		return nil, nil, fmt.Errorf("couldn't find method %q", path)
	}
	if call.NeedsRequest || call.NeedsResponse {
		return nil, nil, fmt.Errorf("method %q needs an HTTP request", path)
	}
	job, out, err := runJob(ctx, call.Fn, in, o)
	return out, job, err
}

func CallIn(ctx context.Context, path string, in rc.Params) (rc.Params, error) {
	path = strings.TrimPrefix(path, "/")
	if _, ok := jobs.GetJob(ctx); !ok {
		return nil, fmt.Errorf("method %q called outside a job", path)
	}
	call := rc.Calls.Get(path)
	if call == nil {
		return nil, fmt.Errorf("couldn't find method %q", path)
	}
	if call.NeedsRequest || call.NeedsResponse {
		return nil, fmt.Errorf("method %q needs an HTTP request", path)
	}
	return call.Fn(ctx, in.Copy())
}

func runJob(ctx context.Context, fn rc.Func, in rc.Params, o CallOpts) (*jobs.Job, rc.Params, error) {
	params := make(rc.Params, len(in)+2)
	maps.Copy(params, in)
	if o.Async {
		params["_async"] = true
	}
	if o.Group != "" {
		params["_group"] = o.Group
	}
	job, out, err := jobs.NewJob(ctx, fn, params)
	if job != nil && !o.Async && job.Group == fmt.Sprintf("job/%d", job.ID) {
		DeleteGroup(ctx, job.Group)
	}
	return job, out, err
}

func UIGroup(kind, id string) string { return "ui/" + kind + "/" + id }

func DeleteGroup(ctx context.Context, group string) {
	if group == "" {
		return
	}
	if call := rc.Calls.Get("core/stats-delete"); call != nil {
		_, _ = call.Fn(ctx, rc.Params{"group": group})
	}
}
