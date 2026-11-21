package children

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"github.com/rclone/rclone-ui/core/internal/atomicfile"
)

// Kind is the type of a child, as recorded in children.json.
type Kind string

const (
	KindMount  Kind = "mount"
	KindServe  Kind = "serve"
	KindTunnel Kind = "tunnel" // the remote tunnel (`rcui tunnel`)
)

// Record is one child in children.json. It is either a process that is running now (PID and
// StartTime are set), or a mount or serve to start again after a restart (Restore).
type Record struct {
	ID   string `json:"id"` // 8 hex digits, also used in the child's socket name
	Kind Kind   `json:"kind"`
	Name string `json:"name"`
	// PID and StartTime identify a running process. StartTime is the start time that the OS
	// reports (processStartTime), so a pid that another program has reused is never killed.
	PID       int   `json:"pid,omitempty"`
	StartTime int64 `json:"startTime,omitempty"`
	// Args is the child's rclone command line (`rcui <args>`), without the flags that every
	// child gets.
	Args       []string        `json:"args"`
	MountPoint string          `json:"mountPoint,omitempty"`
	Addr       string          `json:"addr,omitempty"`
	NFSPort    int             `json:"nfsPort,omitempty"` // macOS: lets cleanup detect a dead NFS mount
	Meta       json.RawMessage `json:"meta,omitempty"`    // the starter's data (a mount's form arguments)
	Restore    bool            `json:"restore,omitempty"`
	// Stopping marks a running process that StopAll was stopping. If a quit or a restart runs
	// out of time and leaves it running, this record doesn't bring it back at the next start.
	// (A restart keeps a separate Restore record for it.)
	Stopping bool `json:"stopping,omitempty"`
}

// restorable reports whether the child is a mount or serve, which come back after a restart. The
// tunnel comes back through its own record (tunnel.restore).
func (r Record) restorable() bool { return r.Kind == KindMount || r.Kind == KindServe }

const (
	recordsFile    = "children.json"
	recordsVersion = 1
)

type recordsDoc struct {
	Version  int      `json:"version"`
	Children []Record `json:"children"`
}

// readRecords reads <run>/children.json. A missing file means there are no children. A file in
// another version, which another build of the app wrote, is refused rather than guessed at.
func readRecords(runDir string) ([]Record, error) {
	b, err := os.ReadFile(filepath.Join(runDir, recordsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc recordsDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", recordsFile, err)
	}
	if doc.Version != recordsVersion {
		return nil, fmt.Errorf("%s is in version %d, and this build reads version %d", recordsFile, doc.Version, recordsVersion)
	}
	return doc.Children, nil
}

// writeRecords replaces <run>/children.json with a single rename, so a crash leaves either the
// old file or the new one.
func writeRecords(runDir string, recs []Record) error {
	recs = slices.Clone(recs)
	if recs == nil {
		recs = []Record{}
	}
	b, err := json.MarshalIndent(recordsDoc{Version: recordsVersion, Children: recs}, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(runDir, recordsFile), append(b, '\n'), 0o600)
}
