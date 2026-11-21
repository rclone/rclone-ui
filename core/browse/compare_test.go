package browse

import (
	"context"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"
)

func classes(c Comparison) map[Class][]string {
	out := map[Class][]string{}
	for _, p := range c.Pairs {
		out[p.Class] = append(out[p.Class], p.Name)
	}
	return out
}

func TestCompare(t *testing.T) {
	left := MakeTree(t, map[string]string{
		"same.txt":     "hello",
		"Diff.txt":     "aaaa",
		"sizediff.txt": "abc",
		"onlyL.txt":    "l",
		"both/x":       "",
		"dirL/":        "",
		"file-vs-dir":  "f",
		".hidden":      "h",
		"a-only.txt":   "a",
	})
	right := MakeTree(t, map[string]string{
		"same.txt":      "hello",
		"Diff.txt":      "bbbb", // same size, other content
		"sizediff.txt":  "abcdef",
		"onlyR.txt":     "r",
		"both/":         "",
		"dirR/":         "",
		"file-vs-dir/y": "",
		".hidden2":      "h",
	})
	c, err := Compare(context.Background(), left, right, false)
	if err != nil {
		t.Fatal(err)
	}
	want := map[Class][]string{
		OnlyLeft:   {"dirL", "a-only.txt", "onlyL.txt"},
		OnlyRight:  {"dirR", "onlyR.txt"},
		SameByName: {"both", "Diff.txt", "file-vs-dir", "sizediff.txt"},
		SameByHash: {"same.txt"},
	}
	got := classes(c)
	for _, cl := range []Class{OnlyLeft, OnlyRight, SameByName, SameByHash} {
		if !slices.Equal(got[cl], want[cl]) {
			t.Errorf("%s: %q, want %q", cl, got[cl], want[cl])
		}
	}
	// The classes come in order, and each pair has the sides that hold its name.
	var order []Class
	for _, p := range c.Pairs {
		if len(order) == 0 || order[len(order)-1] != p.Class {
			order = append(order, p.Class)
		}
		if (p.Left == nil) != (p.Class == OnlyRight) || (p.Right == nil) != (p.Class == OnlyLeft) {
			t.Errorf("%+v: sides", p)
		}
	}
	if !slices.Equal(order, []Class{OnlyLeft, OnlyRight, SameByName, SameByHash}) {
		t.Errorf("class order %q", order)
	}
	if p := c.Pairs[len(c.Pairs)-1]; p.Left.Size != 5 || p.Left.ModTime == "" || p.Left.IsDir {
		t.Errorf("side %+v", *p.Left)
	}
}

func TestCompareAcrossBackendsUsesACommonHash(t *testing.T) {
	ctx := context.Background()
	f, err := cache.Get(ctx, ":memory:compare")
	if err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"same": "content", "differs": "other!"} {
		if _, err := operations.Rcat(ctx, f, "d/"+name, io.NopCloser(strings.NewReader(text)), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	local := MakeTree(t, map[string]string{"same": "content", "differs": "OTHER!"})
	c, err := Compare(ctx, local, ":memory:compare/d", false)
	if err != nil {
		t.Fatal(err)
	}
	got := classes(c)
	if !slices.Equal(got[SameByHash], []string{"same"}) || !slices.Equal(got[SameByName], []string{"differs"}) {
		t.Errorf("%v", got)
	}
}

func TestCompareFailsOnAMissingSide(t *testing.T) {
	if _, err := Compare(context.Background(), MakeTree(t, map[string]string{"a": ""}), "/does/not/exist/rcc", false); err == nil ||
		!strings.HasPrefix(err.Error(), "/does/not/exist/rcc: ") {
		t.Fatalf("err %v", err)
	}
}

// A side with more names than CompareMax stops at the cap, and the comparison reports it. That
// holds whether the other side is also too large or is empty. A comparison of one name against
// one is complete.
func TestCompareSaysWhenASideWasCut(t *testing.T) {
	ctx := context.Background()
	many := memoryFiles(t, "d", CompareMax+50) + "/d"
	empty := MakeTree(t, map[string]string{"empty/": ""}) + "/empty"
	one := MakeTree(t, map[string]string{"a": "a"})
	for _, tc := range []struct {
		name        string
		left, right string
		capped      bool
	}{
		{"both sides cut", many, many, true},
		{"one side cut", many, empty, true},
		{"the other side cut", empty, many, true},
		{"one against one", one, one, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := Compare(ctx, tc.left, tc.right, false)
			if err != nil || c.Capped != tc.capped {
				t.Fatalf("capped %v, %v", c.Capped, err)
			}
		})
	}
	// The API reports it too, even though it sends only CompareMax pairs.
	res, err := testAPI().Compare(ctx, many, empty, false)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Capped || len(res.Pairs) != CompareMax {
		t.Fatalf("capped %v, %d pairs", res.Capped, len(res.Pairs))
	}
}

// A backend whose listing calls fs.Fatalf fails the comparison, which runs each side as its own
// job. The core keeps running.
func TestAFatalListingInCompareIsTheReadsError(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, map[string]string{"a": "a"}), Hook: func(context.Context, string) error {
		fs.Fatalf(nil, "the backend gave up")
		return nil
	}}
	_, err := testAPI().Compare(context.Background(), AddFixture(fx), MakeTree(t, map[string]string{"a": "a"}), false)
	if err == nil || !strings.Contains(err.Error(), "the backend gave up") {
		t.Fatalf("got %v", err)
	}
}
