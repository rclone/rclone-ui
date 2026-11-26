package catalog

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/location"
)

type Group map[string]json.RawMessage

var remotePathOptions = []string{"backup_dir", "compare_dest", "copy_dest", "backup_dir1", "backup_dir2"}

// RenameRemote rewrites the values of the options that hold a path on the remote from, after the
// remote is renamed to to. A value can be one path or a list of paths. Keys are matched with
// dashes or underscores, and with or without leading dashes. It changes g in place, and reports
// whether anything changed.
func (g Group) RenameRemote(from, to string) bool {
	changed := false
	for key, value := range g {
		name := strings.ReplaceAll(strings.TrimLeft(key, "-"), "-", "_")
		if !slices.Contains(remotePathOptions, name) {
			continue
		}
		if renamed, ok := renameInValue(value, from, to); ok {
			g[key] = renamed
			changed = true
		}
	}
	return changed
}

func renameInValue(value json.RawMessage, from, to string) (json.RawMessage, bool) {
	var one string
	if json.Unmarshal(value, &one) == nil {
		p, ok := location.RenameRemote(one, from, to)
		if !ok {
			return nil, false
		}
		return marshal(p), true
	}
	var list []json.RawMessage
	if json.Unmarshal(value, &list) != nil {
		return nil, false
	}
	changed := false
	for i, elem := range list {
		if json.Unmarshal(elem, &one) != nil {
			continue
		}
		if p, ok := location.RenameRemote(one, from, to); ok {
			list[i] = marshal(p)
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	return marshal(list), true
}

func marshal(v any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimRight(b.Bytes(), "\n")
}
