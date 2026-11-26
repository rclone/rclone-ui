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

const PlanVersion = 1

type Plan struct {
	V           int            `json:"v"`
	Steps       []Step         `json:"steps"`
	Config      Options        `json:"config,omitempty"`
	Filter      Options        `json:"filter,omitempty"`
	Bisync      map[string]any `json:"bisync,omitempty"`
	Concurrency int            `json:"concurrency,omitempty"`
	Landings    []Landing      `json:"-"`
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

type Step struct {
	Op                 string `json:"op"`
	Src                string `json:"src,omitempty"`
	SrcRemote          string `json:"srcRemote,omitempty"`
	Dst                string `json:"dst,omitempty"`
	DstRemote          string `json:"dstRemote,omitempty"`
	URL                string `json:"url,omitempty"`
	CreateEmptySrcDirs bool   `json:"createEmptySrcDirs,omitempty"`
	DeleteEmptySrcDirs bool   `json:"deleteEmptySrcDirs,omitempty"`
	Rename             bool   `json:"rename,omitempty"`
	RemoveSrc          bool   `json:"removeSrc,omitempty"`
}

const (
	OpCopy       = "copy"
	OpMove       = "move"
	OpSync       = "sync"
	OpBisync     = "bisync"
	OpCopyFile   = "copyfile"
	OpMoveFile   = "movefile"
	OpDelete     = "delete"
	OpDeleteFile = "deletefile"
	OpPurge      = "purge"
	OpCleanup    = "cleanup"
	OpCopyURL    = "copyurl"
)

func (s Step) Folder() bool {
	switch s.Op {
	case OpCopy, OpMove, OpSync, OpBisync, OpDelete:
		return true
	}
	return false
}

func (s Step) File() bool {
	return s.Op == OpCopyFile || s.Op == OpMoveFile || s.Op == OpDeleteFile
}

func (s Step) Label() string {
	for _, v := range []string{s.SrcRemote, s.DstRemote, s.Src, s.Dst} {
		if v != "" {
			return v
		}
	}
	return "unknown"
}

func (p Plan) Whole() bool {
	return len(p.Steps) == 1 && (p.Steps[0].Op == OpSync || p.Steps[0].Op == OpBisync)
}

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

// Bisync reads its own switch when it writes its listings. With only the config option, it would
// record changes in its listings as done, although it only reported them.
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

func (s Step) Source() string {
	if s.Src != "" {
		return joinFs(s.Src, s.SrcRemote)
	}
	return joinFs(s.Dst, s.DstRemote)
}

// fspath.JoinRootPath keeps the `//` that starts a Windows share only at the start of the whole
// string, so a share after a backend's name (`:local://server/share/`) is joined as a path of its
// own. With one slash it would be a folder on the current drive.
func joinFs(f, remote string) string {
	parsed, err := fspath.Parse(f)
	if err != nil || parsed.Name == "" || !strings.HasPrefix(parsed.Path, "//") {
		return fspath.JoinRootPath(f, remote)
	}
	return parsed.ConfigString + ":" + fspath.JoinRootPath(parsed.Path, remote)
}

func (p Plan) MarshalJSON() ([]byte, error) {
	type plan Plan
	if p.V == 0 {
		p.V = PlanVersion
	}
	return json.Marshal(plan(p))
}
