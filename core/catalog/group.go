package catalog

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/location"
)

// Group holds the options of one group of a form, such as its config or filter options, keyed by
// rclone's option name as the page wrote it. Each value stays the JSON that the page sent, so a
// number such as 1.50 keeps every digit until rclone's own parser reads it.
type Group map[string]json.RawMessage

// remotePathOptions are the options whose value rclone opens as a path, so they can name a
// remote. compare_dest and copy_dest can hold a list. backup_dir1 and backup_dir2 are bisync's.
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

// renameInValue rewrites a value that is a path or a list of paths. It returns the new JSON and
// whether anything changed. In a list, other values are kept as they are.
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

// marshal writes v as JSON without escaping <, > and &, which can appear in paths.
func marshal(v any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v) // strings and lists of raw JSON always encode
	return bytes.TrimRight(b.Bytes(), "\n")
}
