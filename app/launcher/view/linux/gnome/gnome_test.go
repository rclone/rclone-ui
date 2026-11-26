package gnome

import (
	"encoding/json"
	"testing"
)

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

func TestUserCopy(t *testing.T) {
	const none = -1
	for _, c := range []struct {
		system, user, ours int
		want               Action
	}{
		{none, none, 2, Write},
		{none, 1, 2, Write},
		{none, 2, 2, Write},
		{none, 3, 2, Keep},
		{2, none, 2, Keep},
		{2, 0, 2, Remove},
		{3, 2, 2, Remove},
		{2, 2, 2, Remove},
		{2, 3, 2, Keep},
		{1, none, 2, Write},
		{1, 1, 2, Write},
		{0, none, 2, Write},
	} {
		if got := UserCopy(c.system, c.user, c.ours); got != c.want {
			t.Errorf("UserCopy(%d, %d, %d) = %d, want %d", c.system, c.user, c.ours, got, c.want)
		}
	}
}
