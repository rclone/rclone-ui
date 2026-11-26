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

type Kind string

const (
	KindMount  Kind = "mount"
	KindServe  Kind = "serve"
	KindTunnel Kind = "tunnel"
)

type Record struct {
	ID   string `json:"id"`
	Kind Kind   `json:"kind"`
	Name string `json:"name"`
	// PID and StartTime identify a running process. StartTime is the start time that the OS
	// reports (processStartTime), so a pid that another program has reused is never killed.
	PID        int             `json:"pid,omitempty"`
	StartTime  int64           `json:"startTime,omitempty"`
	Args       []string        `json:"args"`
	MountPoint string          `json:"mountPoint,omitempty"`
	Addr       string          `json:"addr,omitempty"`
	NFSPort    int             `json:"nfsPort,omitempty"`
	Meta       json.RawMessage `json:"meta,omitempty"`
	Restore    bool            `json:"restore,omitempty"`
	Stopping   bool            `json:"stopping,omitempty"`
}

func (r Record) restorable() bool { return r.Kind == KindMount || r.Kind == KindServe }

const (
	recordsFile    = "children.json"
	recordsVersion = 1
)

type recordsDoc struct {
	Version  int      `json:"version"`
	Children []Record `json:"children"`
}

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
