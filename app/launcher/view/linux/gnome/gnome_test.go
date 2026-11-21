package gnome

import (
	"encoding/json"
	"testing"
)

// TestMetadata checks that the extension's metadata parses, has the right UUID, lists the GNOME
// versions it runs on, and has a version so that a newer copy can replace an older one.
func TestMetadata(t *testing.T) {
	raw, err := Files.ReadFile("metadata.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		UUID    string   `json:"uuid"`
		Name    string   `json:"name"`
		Version []string `json:"shell-version"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m.UUID != UUID || m.Name == "" || len(m.Version) == 0 {
		t.Fatalf("metadata %+v", m)
	}
	if Ours() < 1 {
		t.Fatalf("version %d", Ours())
	}
	if _, err := Files.ReadFile("extension.js"); err != nil {
		t.Fatal(err)
	}
}

func TestVersion(t *testing.T) {
	for in, want := range map[string]int{`{"version": 3}`: 3, `{}`: 0, `{"version": "x"}`: 0, `not json`: 0} {
		if got := Version([]byte(in)); got != want {
			t.Errorf("Version(%s) = %d, want %d", in, got, want)
		}
	}
}

// TestUserCopy checks that the user's copy is only kept while it is newer than the package's, and
// that the newer of the package's and this build's copies runs.
func TestUserCopy(t *testing.T) {
	const none = -1
	for _, c := range []struct {
		system, user, ours int
		want               Action
	}{
		{none, none, 2, Write}, // no package, so install this build's copy
		{none, 1, 2, Write},    // an older copy is updated
		{none, 2, 2, Write},    // the same version, with its files checked
		{none, 3, 2, Keep},     // a copy from a newer build
		{2, none, 2, Keep},     // the package's copy runs
		{2, 0, 2, Remove},      // a stale copy hiding the package's copy
		{3, 2, 2, Remove},      // the package's copy is newer
		{2, 2, 2, Remove},      // the same version as the package's, so remove it
		{2, 3, 2, Keep},        // a copy from a newer build
		{1, none, 2, Write},    // an older package, so install this build's copy
		{1, 1, 2, Write},       // updated
		{0, none, 2, Write},    // a package from before versions
	} {
		if got := UserCopy(c.system, c.user, c.ours); got != c.want {
			t.Errorf("UserCopy(%d, %d, %d) = %d, want %d", c.system, c.user, c.ours, got, c.want)
		}
	}
}
