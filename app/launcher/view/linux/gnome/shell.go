package gnome

import (
	"context"
	"strings"
)

// Acks reads and records the acknowledgements that the app keeps in the pages'
// "acknowledgements" pref. Ensure records one once the extension has been enabled, so that it
// enables the extension only once. If the user turns it off afterwards, that choice is respected.
type Acks struct {
	// Has reports whether key was recorded. It returns true when the list can't be read.
	Has func(ctx context.Context, key string) bool
	Add func(ctx context.Context, key string)
}

const enabledAck = "gnomeLauncherExtension"

// These helpers parse GNOME's replies for Ensure (see ensure_linux.go). They live in their own
// file so that their tests run on any OS.

// GNOME Shell's extension states (its ExtensionState), as GetExtensionInfo reports them.
const (
	extensionActive   = 1
	extensionInactive = 2
)

// extensionState reads the "state" that GetExtensionInfo returns. It is a double, because the
// shell's JavaScript sends numbers that way. It returns 0 when there is no state, which means the
// shell hasn't loaded the extension.
func extensionState(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int32:
		return int(n)
	case uint32:
		return int(n)
	case int64:
		return int(n)
	}
	return 0
}

// parseStrv parses a GSettings string list in the form gsettings prints it: ['a', 'b'], or @as []
// when empty.
func parseStrv(s string) []string {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "@as"))
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	var out []string
	for item := range strings.SplitSeq(s, ",") {
		item = strings.TrimSpace(item)
		if len(item) >= 2 && (item[0] == '\'' || item[0] == '"') && item[len(item)-1] == item[0] {
			out = append(out, item[1:len(item)-1])
		}
	}
	return out
}

// formatStrv writes a string list for gsettings set. Extension UUIDs have no quotes in them.
func formatStrv(list []string) string {
	quoted := make([]string, len(list))
	for i, s := range list {
		quoted[i] = "'" + s + "'"
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}
