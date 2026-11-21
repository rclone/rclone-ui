package operations

import (
	"context"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/rclone"
)

// bisyncHelpParam matches one parameter in the help of sync/bisync, such as
// "- name (required) - (type) …".
var bisyncHelpParam = regexp.MustCompile(`(?m)^- (\w+) `)

// The bisyncParams list matches the parameters of rclone's sync/bisync (its rc help,
// cmd/bisync/rc.md) in both directions. The Bisync page may set every documented parameter except
// the two paths, which are a step's Src and Dst, and every name that the page may set is one that
// rclone reads.
func TestBisyncParamsAreRclones(t *testing.T) {
	call := rc.Calls.Get("sync/bisync")
	if call == nil {
		t.Fatal("sync/bisync is not registered")
	}
	var documented []string
	for _, m := range bisyncHelpParam.FindAllStringSubmatch(call.Help, -1) {
		documented = append(documented, m[1])
	}
	if len(documented) < 20 || !slices.Contains(documented, "path1") {
		t.Fatalf("sync/bisync's help lists %v", documented)
	}
	for _, name := range documented {
		if name != "path1" && name != "path2" && !slices.Contains(bisyncParams, name) {
			t.Errorf("rclone's sync/bisync takes %s, which the Bisync page can't set", name)
		}
	}
	// rclone reads maxDelete, which its help doesn't list (rcBisync in cmd/bisync/rc.go).
	for _, name := range bisyncParams {
		if !slices.Contains(documented, name) && name != "maxDelete" {
			t.Errorf("%s is not a parameter of rclone's sync/bisync", name)
		}
	}
	// maxDelete is read before the paths, so a value out of range is refused by name.
	_, _, err := rclone.Call(context.Background(), "sync/bisync", rc.Params{"maxDelete": 200}, rclone.CallOpts{})
	if err == nil || !strings.Contains(err.Error(), "maxDelete") {
		t.Errorf("rclone's sync/bisync does not read maxDelete: %v", err)
	}
}

// A bisync that runs by itself drops the switches of a run that someone started, and keeps the
// rest. Only the switches that are on become parameters.
func TestUnattendedBisync(t *testing.T) {
	most := 10
	s := UnattendedBisync(BisyncSwitches{
		DryRun: true, Resync: true, Force: true, ResyncMode: "path1", MaxDelete: &most, CheckAccess: true,
	}, false, "")
	want := map[string]any{"maxDelete": 10, "checkAccess": true, "resilient": true, "recover": true, "maxLock": "2m"}
	if got := s.params(); !reflect.DeepEqual(got, want) {
		t.Errorf("params %v, want %v", got, want)
	}
	s = UnattendedBisync(BisyncSwitches{}, true, "/data/bisync")
	if !s.Resync || s.ResyncMode != "newer" || s.Workdir != "/data/bisync" {
		t.Errorf("a merge %+v", s)
	}
}
