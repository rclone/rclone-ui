package match

import (
	"reflect"
	"sort"
	"testing"
)

func TestMatchPositions(t *testing.T) {
	cases := []struct {
		pattern, text string
		ok            bool
		pos           []int
	}{
		{"", "Copy", true, nil},
		{"cp", "Copy", true, []int{0, 2}},
		{"mo", "Move", true, []int{0, 1}},
		{"mo", "New Remote", true, []int{6, 7}},
		{"gdr", "Browse gdrive:", true, []int{7, 8, 9}},
		{"copy gd", "Copy gdrive: → /tmp", true, []int{0, 1, 2, 3, 5, 6}},
		{"xyz", "Copy", false, nil},
		{"MOUNT", "Mount gdrive:", true, []int{0, 1, 2, 3, 4}},
		{"sr", "Show Remotes", true, []int{0, 5}},
	}
	for _, c := range cases {
		r, ok := Match(c.pattern, c.text)
		if ok != c.ok {
			t.Errorf("Match(%q, %q) ok = %v", c.pattern, c.text, ok)
			continue
		}
		if ok && !reflect.DeepEqual(r.Positions, c.pos) {
			t.Errorf("Match(%q, %q) positions = %v, want %v", c.pattern, c.text, r.Positions, c.pos)
		}
	}
}

// rank orders texts by their score for pattern, best first. Ties keep their order.
func rank(pattern string, texts []string) []string {
	type scored struct {
		text  string
		score int
	}
	var out []scored
	for _, s := range texts {
		if r, ok := Match(pattern, s); ok {
			out = append(out, scored{s, r.Score})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	names := make([]string, len(out))
	for i, s := range out {
		names[i] = s.text
	}
	return names
}

func TestMatchRanking(t *testing.T) {
	commands := []string{"Bisync", "Copy", "Download", "Move", "Mount", "New Remote", "Serve", "Settings", "Show Remotes", "Sync"}
	cases := []struct {
		pattern string
		first   []string // the leading results, in order
	}{
		{"copy", []string{"Copy"}},
		{"mo", []string{"Move", "Mount"}},
		{"sync", []string{"Sync", "Bisync"}},
		{"set", []string{"Settings"}},
		{"rem", []string{"New Remote", "Show Remotes"}},
		{"s", []string{"Serve", "Settings", "Show Remotes", "Sync"}},
	}
	for _, c := range cases {
		got := rank(c.pattern, commands)
		if len(got) < len(c.first) || !reflect.DeepEqual(got[:len(c.first)], c.first) {
			t.Errorf("rank(%q) = %v, want it to start with %v", c.pattern, got, c.first)
		}
	}
}

func TestExactBeatsPrefix(t *testing.T) {
	exact, _ := Match("sync", "Sync")
	prefix, _ := Match("sync", "Synchronise")
	inner, _ := Match("sync", "Bisync")
	if !(exact.Score > prefix.Score && prefix.Score > inner.Score) {
		t.Errorf("scores exact %d, prefix %d, inner %d", exact.Score, prefix.Score, inner.Score)
	}
}

// TestExactAddsExactBonus: a pattern that equals the whole text, ignoring case and spaces, scores
// ExactBonus more than the same letters matched in a longer text.
func TestExactAddsExactBonus(t *testing.T) {
	for _, c := range []struct {
		pattern, text string
		exact         bool
	}{
		{"sync", "Sync", true},
		{" SYNC ", "sync", true},
		{"sync", "Sync ", true},
		{"sync", "Synced", false},
		{"syn", "Sync", false},
	} {
		if got := Exact(c.pattern, c.text); got != c.exact {
			t.Errorf("Exact(%q, %q) = %v", c.pattern, c.text, got)
		}
	}
	exact, _ := Match("Sync", "Sync")
	longer, _ := Match("Sync", "Sync x")
	if exact.Score-longer.Score != ExactBonus {
		t.Errorf("exact %d, the same letters in a longer text %d", exact.Score, longer.Score)
	}
}
