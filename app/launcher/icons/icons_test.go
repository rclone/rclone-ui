package icons

import (
	"strings"
	"testing"
)

// TestTinted: every black in the glyph is replaced by the given colour, and an unknown name has no
// glyph.
func TestTinted(t *testing.T) {
	got := Tinted(Copy, "#ffffff")
	if got == "" || strings.Contains(got, `"#000"`) || !strings.Contains(got, `"#ffffff"`) {
		t.Fatalf("tinted: %s", got)
	}
	if want := strings.ReplaceAll(SVG(Copy), `"#000"`, `"#ffffff"`); got != want {
		t.Fatalf("tinted:\n got %s\nwant %s", got, want)
	}
	if got := Tinted("no-such-glyph", "#ffffff"); got != "" {
		t.Fatalf("an unknown name: %q", got)
	}
}
