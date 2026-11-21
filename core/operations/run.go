package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/cmd/bisync/bilib"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/filter"
	rcops "github.com/rclone/rclone/fs/operations"
	"github.com/rclone/rclone/fs/rc"
	rcsync "github.com/rclone/rclone/fs/sync"

	"github.com/rclone/rclone-ui/core/metadatamap"
	"github.com/rclone/rclone-ui/core/rclone"
)

// MaxFailures is how many failed files from a plan's sync steps a Record keeps. It keeps the
// first ones, and the limit matches the number of failed files that the ledger keeps for a
// transfer.
const MaxFailures = 1000

// Record tracks what a running plan has done so far, step by step. For each step, it holds the
// names of the step's Fs as rclone reports them in a finished file's snapshot. These come from
// fs.ConfigString, such as `gdrive{AbCdE}:photos`, and differ from the connection string that the
// Fs was opened with. A reader uses them to tell which step a file belongs to. The record also
// holds when each step ends, and the files that a sync failed to transfer.
type Record struct {
	mu    sync.Mutex
	steps []StepRecord
	// failed holds the first MaxFailures files that a sync failed to transfer. failures counts
	// all of them.
	failed   []Failure
	failures int
}

// StepRecord is the part of a Record for one step.
type StepRecord struct {
	// SrcFs and DstFs are the fs.ConfigString names of the Fs that the step opened for Src and
	// Dst. They are empty until the step opens them.
	SrcFs, DstFs string
	Ended        bool
	Err          error // set once Ended if the step failed
}

// Failure is a file that a sync step failed to transfer, as reported by rclone's sync logger. It
// is named the same way as in a finished file's snapshot: the Fs by fs.ConfigString, and the file
// by its path inside it. Failures are recorded here because rclone keeps only the last
// maxCompleted snapshots of a group. A sync that checks thousands of unchanged files a second
// would push a failure out before anything reads it.
type Failure struct {
	SrcFs, Name, DstFs, Err string
	Size                    int64
	At                      time.Time
}

func NewRecord(p Plan) *Record { return &Record{steps: make([]StepRecord, len(p.Steps))} }

// Steps returns a copy of the step records.
func (r *Record) Steps() []StepRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StepRecord(nil), r.steps...)
}

// Failures returns a copy of the first MaxFailures files that the plan's sync steps failed to
// transfer, in the order they failed, and the total number of failures.
func (r *Record) Failures() ([]Failure, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Failure(nil), r.failed...), r.failures
}

// syncLogger returns rclone's logger for step i, which is a sync. It keeps the first files that
// failed to transfer and counts all of them. rclone calls it from its sync goroutines, where no
// job runner recovers a panic, so it only checks types and appends. Copy and move steps don't get
// a logger, because when any logger is set, rclone walks every folder that exists only on the
// destination (NoProcessDstOnly in fs/sync).
func (r *Record) syncLogger(i int) rcops.LoggerFn {
	return func(_ context.Context, sigil rcops.Sigil, src, _ fs.DirEntry, err error) {
		o, ok := src.(fs.ObjectInfo) // a folder or a missing source is not a file failure
		if sigil != rcops.TransferError || err == nil || !ok || o.Fs() == nil {
			return
		}
		f := Failure{
			SrcFs: fs.ConfigString(o.Fs()), // the same name the snapshots use
			Name:  o.Remote(), Err: err.Error(), Size: o.Size(), At: time.Now(),
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.failures++
		if len(r.failed) == MaxFailures {
			return
		}
		f.DstFs = r.steps[i].DstFs
		r.failed = append(r.failed, f)
	}
}

func (r *Record) update(i int, fn func(*StepRecord)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn(&r.steps[i])
}

// Run runs the plan on ctx, which belongs to a job (rclone.Run). The plan's config is added to
// ctx, with the app's own metadata mapper pointed at exe, the running executable. The plan's
// filter is added to the context of the folder steps. The steps then run, Concurrency at a time.
// The end of every step is recorded in rec, which may be nil. Every step runs on ctx, so stopping
// the job cancels them all.
//
// The returned error is the job's error. It is set when the options are refused, or when the
// single step of a Whole plan fails. In a batch, each step fails on its own, and the errors are
// only in rec.
func (p Plan) Run(ctx context.Context, exe string, rec *Record) error {
	if rec == nil {
		rec = NewRecord(p)
	}
	ctx, ci := fs.AddConfig(ctx)
	if err := setOptions(blockMain, runnableConfig(p.Config, exe), ci); err != nil {
		return err
	}
	folderCtx := ctx
	if len(p.Filter) > 0 {
		opt := filter.GetConfig(ctx).Opt
		if err := setOptions(blockFilter, p.Filter, &opt); err != nil {
			return err
		}
		fi, err := filter.NewFilter(&opt)
		if err != nil {
			return err
		}
		folderCtx = filter.ReplaceConfig(ctx, fi)
	}
	concurrency := p.Concurrency
	if concurrency <= 0 {
		concurrency = ci.Transfers
	}
	// Each step runs as its own job in the plan's stats group, because rclone only turns a fatal
	// error into a recoverable one on a goroutine that its job runner manages.
	group, _ := accounting.StatsGroupFromContext(ctx)
	turns := make(chan struct{}, max(concurrency, 1))
	var wg sync.WaitGroup
	for i, s := range p.Steps {
		stepCtx := ctx
		if s.Folder() {
			stepCtx = folderCtx
		}
		turns <- struct{}{}
		wg.Go(func() {
			defer func() { <-turns }()
			// A step whose turn comes after a stop doesn't start.
			err := stepCtx.Err()
			if err == nil {
				_, err = rclone.Run(stepCtx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
					return p.runStep(ctx, i, s, rec)
				})
			}
			rec.update(i, func(r *StepRecord) { r.Ended, r.Err = true, err })
		})
	}
	wg.Wait()
	if p.Whole() {
		return rec.Steps()[0].Err
	}
	return nil
}

// runnableConfig returns a plan's config with the app's own metadata mapper pointed at exe.
func runnableConfig(config Options, exe string) Options {
	v, ok := config["metadata_mapper"]
	if !ok {
		return config
	}
	argv, err := valueOf(fs.SpaceSepList{}, v)
	if err != nil {
		return config // setOptions refuses it later, with the option's name
	}
	out := maps.Clone(config)
	out["metadata_mapper"] = metadatamap.Runnable(argv.(fs.SpaceSepList), exe)
	return out
}

// rcValue converts a parameter to the type that rclone's rc would get from JSON. Its getters
// accept a number as an int64 or a float64, but not as the json.Number that a stored plan is
// decoded with.
func rcValue(v any) any {
	n, ok := v.(json.Number)
	if !ok {
		return v
	}
	if i, err := n.Int64(); err == nil {
		return i
	}
	if f, err := n.Float64(); err == nil {
		return f
	}
	return n.String()
}

// bisyncBase returns the start of the names of a bisync's listings (bilib.BasePath), or "" when
// its working folder can't be told.
func (p Plan) bisyncBase(ctx context.Context, path1, path2 fs.Fs) string {
	workDir, _ := p.Bisync["workdir"].(string)
	if workDir == "" {
		workDir = bisync.DefaultWorkdir
	}
	workDir, err := filepath.Abs(workDir)
	if err != nil {
		return ""
	}
	return bilib.BasePath(ctx, workDir, path1, path2)
}

// firstBisync reports whether a bisync of path1 and path2 has no listings from an earlier run in
// its working folder, so rclone refuses it unless it is a resync.
func (p Plan) firstBisync(ctx context.Context, path1, path2 fs.Fs) bool {
	if resync, _ := p.Bisync["resync"].(bool); resync {
		return false
	}
	base := p.bisyncBase(ctx, path1, path2)
	if base == "" {
		return false
	}
	for _, listing := range []string{base + ".path1.lst", base + ".path2.lst"} {
		if _, err := os.Stat(listing); err != nil {
			return true
		}
	}
	return false
}

// open returns the Fs for a step's path from rclone's cache, where it stays pinned until the job
// ends. It passes the Fs name to set, so the step's files can be matched to the step.
func open(ctx context.Context, path string, set func(name string)) (fs.Fs, error) {
	f, err := cache.Get(ctx, path)
	if err != nil {
		return nil, err
	}
	set(fs.ConfigString(f))
	return f, nil
}

func (p Plan) runStep(ctx context.Context, i int, s Step, rec *Record) error {
	var src, dst fs.Fs
	if s.Src != "" {
		f, err := open(ctx, s.Src, func(name string) { rec.update(i, func(r *StepRecord) { r.SrcFs = name }) })
		if err != nil {
			return err
		}
		src = f
	}
	if s.Dst != "" {
		f, err := open(ctx, s.Dst, func(name string) { rec.update(i, func(r *StepRecord) { r.DstFs = name }) })
		if err != nil {
			return err
		}
		dst = f
	}
	switch s.Op {
	case OpCopy:
		return rcsync.CopyDir(ctx, dst, src, s.CreateEmptySrcDirs)
	case OpMove:
		// This also handles a folder rename. MoveDir first tries the backend's own directory
		// move (same remote, no filters), and otherwise moves file by file on this job's
		// context. operations.DirMove is not used, because its fallback runs the moves on a
		// context of its own, outside the job's stats group, and they keep going after a stop.
		// A rename that only changes a folder's case takes two moves.
		if caseOnlyDirs(src, dst) {
			return moveDirCaseOnly(ctx, s, src, dst)
		}
		if err := rcsync.MoveDir(ctx, dst, src, s.DeleteEmptySrcDirs, s.CreateEmptySrcDirs); err != nil || !s.Rename {
			return err
		}
		// A move file by file leaves the old folder, now empty. A backend's own folder move left
		// nothing to remove.
		removeEmptied(ctx, src)
		return nil
	case OpSync:
		// A retry of a failed file can't fall back to a sync step, so the sync's failures are
		// recorded as they happen instead of relying on the snapshots that rclone still holds.
		return rcsync.Sync(rcops.WithLogger(ctx, rec.syncLogger(i)), dst, src, s.CreateEmptySrcDirs)
	case OpBisync:
		// sync/bisync is where rclone turns these parameters into bisync's options. It checks
		// them, fills in defaults, and sets the dry run in both places that bisync reads it.
		// The Bisync page's switches are these parameters, so they are passed on unchanged.
		in := rc.Params{"path1": s.Src, "path2": s.Dst}
		for name, v := range p.Bisync {
			in[name] = rcValue(v)
		}
		first := p.firstBisync(ctx, src, dst)
		heard := hearBisync(bilib.FsPath(src), bilib.FsPath(dst), p.bisyncBase(ctx, src, dst))
		_, err := rclone.CallIn(ctx, "sync/bisync", in)
		said := heard()
		if first && errors.Is(err, bisync.ErrBisyncAborted) {
			// bisync only logs why it aborted. Without listings from an earlier run, it needs a
			// resync to set the baseline. IsFirstRun reads this error back, and the Bisync page
			// offers the resync.
			return fmt.Errorf("%s: %w", noListings, err)
		}
		return p.bisyncError(ctx, err, src, dst, said)
	case OpCopyFile:
		return rcops.CopyFile(ctx, dst, src, s.DstRemote, s.SrcRemote)
	case OpMoveFile:
		if s.Rename {
			return renameFile(ctx, dst, src, s.DstRemote, s.SrcRemote)
		}
		// This also handles a retried file in a folder whose case changed (photos/a → Photos/a).
		return MoveFileCaseSafe(ctx, dst, src, s.DstRemote, s.SrcRemote)
	case OpDelete:
		return rcops.Delete(ctx, src)
	case OpDeleteFile:
		o, err := src.NewObject(ctx, s.SrcRemote)
		if err != nil {
			return err
		}
		return rcops.DeleteFile(ctx, o)
	case OpPurge:
		return rcops.Purge(ctx, src, s.SrcRemote)
	case OpCleanup:
		return rcops.CleanUp(ctx, src)
	case OpCopyURL:
		_, err := rcops.CopyURL(ctx, dst, s.DstRemote, s.URL, false, false, false)
		return err
	}
	return fmt.Errorf("%q is not an operation of rclone's", s.Op)
}
