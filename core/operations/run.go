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

const MaxFailures = 1000

type Record struct {
	mu       sync.Mutex
	steps    []StepRecord
	failed   []Failure
	failures int
}

type StepRecord struct {
	SrcFs, DstFs string
	Ended        bool
	Err          error
}

// Failures are recorded here because rclone keeps only the last maxCompleted snapshots of a
// group. A sync that checks thousands of unchanged files a second would push a failure out before
// anything reads it.
type Failure struct {
	SrcFs, Name, DstFs, Err string
	Size                    int64
	At                      time.Time
}

func NewRecord(p Plan) *Record { return &Record{steps: make([]StepRecord, len(p.Steps))} }

func (r *Record) Steps() []StepRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StepRecord(nil), r.steps...)
}

func (r *Record) Failures() ([]Failure, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Failure(nil), r.failed...), r.failures
}

// rclone calls the logger from its sync goroutines, where no job runner recovers a panic, so it
// only checks types and appends. Copy and move steps don't get a logger, because when any logger
// is set, rclone walks every folder that exists only on the destination (NoProcessDstOnly in
// fs/sync).
func (r *Record) syncLogger(i int) rcops.LoggerFn {
	return func(_ context.Context, sigil rcops.Sigil, src, _ fs.DirEntry, err error) {
		o, ok := src.(fs.ObjectInfo)
		if sigil != rcops.TransferError || err == nil || !ok || o.Fs() == nil {
			return
		}
		f := Failure{
			SrcFs: fs.ConfigString(o.Fs()),
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

func runnableConfig(config Options, exe string) Options {
	v, ok := config["metadata_mapper"]
	if !ok {
		return config
	}
	argv, err := valueOf(fs.SpaceSepList{}, v)
	if err != nil {
		return config
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

// rclone's cache pins the Fs until the job ends.
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
		// operations.DirMove is not used, because its fallback runs the moves on a context of
		// its own, outside the job's stats group, and they keep going after a stop.
		if caseOnlyDirs(src, dst) {
			return moveDirCaseOnly(ctx, s, src, dst)
		}
		if err := rcsync.MoveDir(ctx, dst, src, s.DeleteEmptySrcDirs, s.CreateEmptySrcDirs); err != nil || !(s.Rename || s.RemoveSrc) {
			return err
		}
		removeEmptied(ctx, src)
		return nil
	case OpSync:
		return rcsync.Sync(rcops.WithLogger(ctx, rec.syncLogger(i)), dst, src, s.CreateEmptySrcDirs)
	case OpBisync:
		// sync/bisync is where rclone turns these parameters into bisync's options. It checks
		// them, fills in defaults, and sets the dry run in both places that bisync reads it.
		in := rc.Params{"path1": s.Src, "path2": s.Dst}
		for name, v := range p.Bisync {
			in[name] = rcValue(v)
		}
		first := p.firstBisync(ctx, src, dst)
		heard := hearBisync(bilib.FsPath(src), bilib.FsPath(dst), p.bisyncBase(ctx, src, dst))
		_, err := rclone.CallIn(ctx, "sync/bisync", in)
		said := heard()
		if first && errors.Is(err, bisync.ErrBisyncAborted) {
			// bisync only logs why it aborted.
			return fmt.Errorf("%s: %w", noListings, err)
		}
		return p.bisyncError(ctx, err, src, dst, said)
	case OpCopyFile:
		return rcops.CopyFile(ctx, dst, src, s.DstRemote, s.SrcRemote)
	case OpMoveFile:
		if s.Rename {
			return renameFile(ctx, dst, src, s.DstRemote, s.SrcRemote)
		}
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
