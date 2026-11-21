package schedules

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/operations"
)

// withoutSource and unattended return a new form, and leave the schedule's own as it was.
func TestArgsLeaveTheFormAlone(t *testing.T) {
	mv := form("move", json.RawMessage(`{"sources":["/a","/b"],"destination":"/c"}`))
	out, left := withoutSource(mv, "/a")
	if left != 1 || !slices.Equal(out.Move.Sources, []string{"/b"}) || !slices.Equal(mv.Move.Sources, []string{"/a", "/b"}) {
		t.Errorf("without /a: %v, %d left; the schedule's: %v", out.Move.Sources, left, mv.Move.Sources)
	}
	if _, left := withoutSource(form("copy", copyArgs([]string{"/a"}, "/b")), "/a"); left != 0 {
		t.Errorf("a copy's sources were shortened: %d left", left)
	}

	bi := form("bisync", json.RawMessage(`{"source":"/a","destination":"/b","options":{"outer":{"maxDelete":10}}}`))
	run := unattended(bi, true, "/work")
	if o := run.Bisync.Options.Outer; !o.Resync || o.ResyncMode != "newer" || o.Workdir != "/work" {
		t.Errorf("a merge: %+v", o)
	}
	if o := bi.Bisync.Options.Outer; o.Resync || o.Workdir != "" {
		t.Errorf("the schedule's switches changed: %+v", o)
	}
	if o := unattended(operations.Form{Operation: operations.OperationBisync}, false, "").Bisync.Options.Outer; o == nil || !o.Resilient {
		t.Errorf("an empty bisync: %+v", o)
	}
}

// Two forms are the same when they run the same, whatever the order of their options' keys.
func TestSameForm(t *testing.T) {
	a := form("copy", json.RawMessage(`{"sources":["/a"],"destination":"/b","options":{"config":{"transfers":4,"checkers":8}}}`))
	b := form("copy", json.RawMessage(`{"destination":"/b","options":{"config":{"checkers":8,"transfers":4}},"sources":["/a"]}`))
	if !sameForm(a, b) {
		t.Error("the same form differs")
	}
	c := form("move", json.RawMessage(`{"sources":["/a"],"destination":"/b","options":{"config":{"transfers":4,"checkers":8}}}`))
	if sameForm(a, c) {
		t.Error("a move is the same as a copy")
	}
}

// LeftOff names what a schedule leaves off, and leaves the form as it was. A dry run is left off
// in any group, such as the Copy group, where a schedule would otherwise run it as a dry run
// every time.
func TestLeftOff(t *testing.T) {
	cp := form("copy", json.RawMessage(`{"sources":["/a"],"destination":"/b","options":{"copy":{"dry_run":true},"config":{"transfers":4}}}`))
	got, err := LeftOff(cp)
	if err != nil || !slices.Equal(got, []string{"Dry run"}) {
		t.Errorf("a copy: %v %v", got, err)
	}
	if _, ok := cp.Copy.Options.Copy["dry_run"]; !ok {
		t.Error("the form lost its dry run")
	}
	bi := form("bisync", json.RawMessage(`{"source":"/a","destination":"/b","options":{"outer":{"resync":true,"force":true}}}`))
	if got, err := LeftOff(bi); err != nil || !slices.Equal(got, []string{"Resync", "Force"}) {
		t.Errorf("a bisync: %v %v", got, err)
	}
	if !bi.Bisync.Options.Outer.Resync {
		t.Error("the form lost its resync")
	}
	if got, err := LeftOff(form("copy", copyArgs([]string{"/a"}, "/b"))); err != nil || got == nil || len(got) != 0 {
		t.Errorf("nothing to leave off: %v %v", got, err)
	}
}
