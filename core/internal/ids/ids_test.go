package ids

import (
	"regexp"
	"testing"
)

func TestShapes(t *testing.T) {
	if id := New(); !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(id) {
		t.Errorf("New() = %q, want 16 hex digits", id)
	}
	if h := Hex(3); !regexp.MustCompile(`^[0-9a-f]{6}$`).MatchString(h) {
		t.Errorf("Hex(3) = %q, want 6 hex digits", h)
	}
	if New() == New() {
		t.Error("two ids are the same")
	}
}
