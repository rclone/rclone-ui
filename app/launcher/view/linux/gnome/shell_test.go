package gnome

import (
	"slices"
	"testing"
)

func TestStrv(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []string
	}{
		{"@as []\n", nil},
		{"['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']\n", []string{"ding@rastersoft.com", "ubuntu-dock@ubuntu.com"}},
		{"['one@x']", []string{"one@x"}},
	} {
		if got := parseStrv(c.in); !slices.Equal(got, c.want) {
			t.Errorf("%q: got %q", c.in, got)
		}
	}
	list := []string{"a@b", "launcher@rclone.org"}
	if got := parseStrv(formatStrv(list)); !slices.Equal(got, list) {
		t.Errorf("round trip: %q", got)
	}
}

// TestExtensionState checks that the state GNOME sends as a double is read, and that an extension
// the shell hasn't loaded has no state.
func TestExtensionState(t *testing.T) {
	if extensionState(float64(1)) != extensionActive || extensionState(uint32(2)) != extensionInactive || extensionState(nil) != 0 {
		t.Fatal("states")
	}
}
