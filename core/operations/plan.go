package operations

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs/fspath"
)

// PlanVersion is the version of the plans that this build writes and runs.
const PlanVersion = 1

// Plan is a transfer in the form that Run executes and the ledger stores. It holds the steps and
// the options they run with, keyed by rclone's own option names. A step's paths are Fs strings
// that rclone opens as they are, with a remote's overrides already in its connection string.
type Plan struct {
	V     int    `json:"v"`
	Steps []Step `json:"steps"`
	// Config holds rclone's main options for every step (dry_run, transfers, metadata_mapper…).
	// The app's own metadata mapper is stored without the executable's path.
	Config Options `json:"config,omitempty"`
	// Filter holds rclone's filter options, including the metadata rules (metadata_include…).
	// It applies to the steps that read a folder (Step.Folder).
	Filter Options `json:"filter,omitempty"`
	// Bisync holds the parameters of sync/bisync (resync, maxDelete, … in cmd/bisync/rc.go) for
	// a bisync step. They come from the Bisync page's switches.
	Bisync map[string]any `json:"bisync,omitempty"`
	// Concurrency is how many steps run at once. 0 means --transfers, which is also the
	// default of job/batch.
	Concurrency int `json:"concurrency,omitempty"`
	// Landings says where each source of a copy or a move ends up, for the page to show before
	// it starts. It isn't stored with the plan.
	Landings []Landing `json:"-"`
}

// Landing is where one source of a copy or a move ends up in the destination.
type Landing struct {
	Source string `json:"source"`
	// Path is the folder or file that the source becomes, in the form the destination was
	// written in. For a root it is the destination itself.
	Path string `json:"path"`
	// Name is the last name in Path, which the source keeps, or "" for a root.
	Name   string `json:"name"`
	Folder bool   `json:"folder"`
	// Contents is set for a root: it has no name of its own, so its entries go straight into
	// Path.
	Contents bool `json:"contents"`
}

// Step is one of rclone's operations on Fs strings.
type Step struct {
	Op        string `json:"op"`
	Src       string `json:"src,omitempty"`
	SrcRemote string `json:"srcRemote,omitempty"`
	Dst       string `json:"dst,omitempty"`
	DstRemote string `json:"dstRemote,omitempty"`
	URL       string `json:"url,omitempty"`
	// CreateEmptySrcDirs and DeleteEmptySrcDirs are rclone's switches for copying, moving or
	// syncing a folder (--create-empty-src-dirs, --delete-empty-src-dirs).
	CreateEmptySrcDirs bool `json:"createEmptySrcDirs,omitempty"`
	DeleteEmptySrcDirs bool `json:"deleteEmptySrcDirs,omitempty"`
	// Rename marks a step of the Browser's rename (buildRename). Such a file step fails when the
	// file is still at its old name afterwards (renameFile). Such a folder step removes the old
	// folder once it is empty, which a move file by file leaves behind.
	Rename bool `json:"rename,omitempty"`
}

// The operations that a step can run.
const (
	OpCopy       = "copy"       // sync.CopyDir, from the folder Src into the folder Dst
	OpMove       = "move"       // sync.MoveDir
	OpSync       = "sync"       // sync.Sync
	OpBisync     = "bisync"     // sync/bisync, with Src as path1 and Dst as path2
	OpCopyFile   = "copyfile"   // operations.CopyFile, from SrcRemote in Src to DstRemote in Dst
	OpMoveFile   = "movefile"   // operations.MoveFile
	OpDelete     = "delete"     // operations.Delete, on the files in the folder Src
	OpDeleteFile = "deletefile" // operations.DeleteFile, on SrcRemote in Src
	OpPurge      = "purge"      // operations.Purge, on the folder SrcRemote in Src and its contents
	OpCleanup    = "cleanup"    // operations.CleanUp, on the trash and old versions of Src
	OpCopyURL    = "copyurl"    // operations.CopyURL, from URL to DstRemote in Dst
)

// Folder reports whether the step reads the entries of a folder. The plan's filter applies only
// to these steps. A file step names its file directly, so a filter could only exclude it.
func (s Step) Folder() bool {
	switch s.Op {
	case OpCopy, OpMove, OpSync, OpBisync, OpDelete:
		return true
	}
	return false
}

// File reports whether the step acts on a single file, SrcRemote in Src.
func (s Step) File() bool {
	return s.Op == OpCopyFile || s.Op == OpMoveFile || s.Op == OpDeleteFile
}

// Label returns the name used for the step in errors: its file if it has one, or else its
// folder.
func (s Step) Label() string {
	for _, v := range []string{s.SrcRemote, s.DstRemote, s.Src, s.Dst} {
		if v != "" {
			return v
		}
	}
	return "unknown"
}

// Whole reports whether the plan is a single sync or bisync. Such a plan fails as a whole, with
// the step's error. In a batch, each step fails on its own instead.
func (p Plan) Whole() bool {
	return len(p.Steps) == 1 && (p.Steps[0].Op == OpSync || p.Steps[0].Op == OpBisync)
}

// DryRun reports whether the plan asks for a dry run, either with dry_run in its config or with
// bisync's own dryRun switch, which is set by the outer group of the Bisync page.
func (p Plan) DryRun() bool {
	if dry, ok := p.Bisync["dryRun"].(bool); ok && dry && p.hasOp(OpBisync) {
		return true
	}
	if v, ok := p.Config["dry_run"]; ok {
		dry, err := valueOf(false, v)
		return err == nil && dry == true
	}
	return false
}

// WithDryRun returns a copy of the plan that runs as a dry run. It sets dry_run in the config,
// and also bisync's own switch. Bisync reads its own switch when it writes its listings. With
// only the config option, it would record changes in its listings as done, although it only
// reported them.
func (p Plan) WithDryRun() Plan {
	p.Config = maps.Clone(p.Config)
	if p.Config == nil {
		p.Config = Options{}
	}
	p.Config["dry_run"] = "true"
	if p.hasOp(OpBisync) {
		p.Bisync = maps.Clone(p.Bisync)
		if p.Bisync == nil {
			p.Bisync = map[string]any{}
		}
		p.Bisync["dryRun"] = true
	}
	return p
}

func (p Plan) hasOp(op string) bool {
	return slices.ContainsFunc(p.Steps, func(s Step) bool { return s.Op == op })
}

// ParsePlan decodes a stored plan. It refuses any version other than the one this build runs,
// such as a plan written by a newer build before a downgrade.
func ParsePlan(raw []byte) (Plan, error) {
	var p Plan
	if err := decodeJSON(raw, &p); err != nil {
		return Plan{}, fmt.Errorf("the transfer's plan: %w", err)
	}
	if p.V != PlanVersion {
		return Plan{}, fmt.Errorf("the transfer's plan is of version %d; this version of the app runs version %d", p.V, PlanVersion)
	}
	return p, nil
}

// Check returns an error when rclone could not run the plan as it is. That happens when a step
// has an unknown operation or a missing path, or when rclone would refuse an option name or
// value.
func (p Plan) Check() error {
	if p.V != PlanVersion {
		return fmt.Errorf("a plan of version %d, not %d", p.V, PlanVersion)
	}
	if len(p.Steps) == 0 {
		return errors.New("a plan with nothing to do")
	}
	for i, s := range p.Steps {
		if err := s.check(); err != nil {
			return fmt.Errorf("step %d (%s): %w", i+1, s.Op, err)
		}
		if s.Op == OpBisync && len(p.Steps) > 1 {
			return errors.New("a bisync runs alone")
		}
	}
	if _, err := typedOptions(blockMain, p.Config); err != nil {
		return err
	}
	if _, err := typedOptions(blockFilter, p.Filter); err != nil {
		return err
	}
	for name := range p.Bisync {
		if !slices.Contains(bisyncParams, name) {
			return fmt.Errorf("‘%s’ is not a bisync option", name)
		}
	}
	return nil
}

func (s Step) check() error {
	var need []string
	switch s.Op {
	case OpCopy, OpMove, OpSync, OpBisync:
		need = []string{s.Src, s.Dst}
	case OpCopyFile, OpMoveFile:
		need = []string{s.Src, s.SrcRemote, s.Dst, s.DstRemote}
	case OpDelete, OpCleanup:
		need = []string{s.Src}
	case OpDeleteFile, OpPurge:
		need = []string{s.Src, s.SrcRemote}
	case OpCopyURL:
		need = []string{s.URL, s.Dst, s.DstRemote}
	default:
		return errors.New("not an operation of rclone's")
	}
	if slices.Contains(need, "") {
		return errors.New("a path is missing")
	}
	for _, f := range []string{s.Src, s.Dst} {
		if f == "" {
			continue
		}
		if _, err := fspath.Parse(f); err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
	}
	return nil
}

// Source returns the path that a step reads, as the pages show it. For a file, that is its full
// path. Otherwise it is the folder.
func (s Step) Source() string {
	if s.Src != "" {
		return joinFs(s.Src, s.SrcRemote)
	}
	return joinFs(s.Dst, s.DstRemote)
}

// joinFs returns the full path of remote inside the Fs string f, joined by rclone's own function.
// That function keeps the `//` that starts a Windows share only at the start of the whole string,
// so a share after a backend's name (`:local://server/share/`) is joined as a path of its own.
// With one slash it would be a folder on the current drive.
func joinFs(f, remote string) string {
	parsed, err := fspath.Parse(f)
	if err != nil || parsed.Name == "" || !strings.HasPrefix(parsed.Path, "//") {
		return fspath.JoinRootPath(f, remote)
	}
	return parsed.ConfigString + ":" + fspath.JoinRootPath(parsed.Path, remote)
}

// MarshalJSON writes the plan with its version.
func (p Plan) MarshalJSON() ([]byte, error) {
	type plan Plan
	if p.V == 0 {
		p.V = PlanVersion
	}
	return json.Marshal(plan(p))
}
