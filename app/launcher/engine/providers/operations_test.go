package providers

import (
	"strings"
	"testing"
)

// TestCleanupAsks: Cleanup, as a row or in a panel, asks before it deletes anything. No Cleanup
// row is kept in the history, so a typed remote still offers Browse first.
func TestCleanupAsks(t *testing.T) {
	const want = "Clean up gdrive? Trash and old file versions will be removed for good."
	for _, text := range []string{"c", "cl", "clean", "trash", "gdrive", "gdrive:", "cleanup gdrive:"} {
		rs := run(t, text, data(), nil)
		asked := 0
		for _, r := range rs {
			if strings.HasPrefix(r.ID, "op:cleanup") && r.Key != "" {
				t.Errorf("%q: %q has the history key %q", text, r.Title, r.Key)
			}
			for _, a := range r.Actions {
				if a.ID != "cleanup" {
					continue
				}
				asked++
				if a.Confirm != want {
					t.Errorf("%q: %q's Cleanup asks %q", text, r.Title, a.Confirm)
				}
			}
		}
		if asked == 0 {
			t.Errorf("%q: no Cleanup in %q", text, titles(rs))
		}
	}
	if got := first(run(t, "gdrive", data(), nil)); got != "Browse gdrive:" {
		t.Errorf("gdrive: first is %q", got)
	}
}
