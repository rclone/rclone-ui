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

var bisyncHelpParam = regexp.MustCompile(`(?m)^- (\w+) `)

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
	for _, name := range bisyncParams {
		if !slices.Contains(documented, name) && name != "maxDelete" {
			t.Errorf("%s is not a parameter of rclone's sync/bisync", name)
		}
	}
	_, _, err := rclone.Call(context.Background(), "sync/bisync", rc.Params{"maxDelete": 200}, rclone.CallOpts{})
	if err == nil || !strings.Contains(err.Error(), "maxDelete") {
		t.Errorf("rclone's sync/bisync does not read maxDelete: %v", err)
	}
}

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
