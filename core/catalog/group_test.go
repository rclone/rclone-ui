package catalog

import (
	"encoding/json"
	"testing"
)

// A rename rewrites the options that hold a path on the remote, one path or a list, and leaves
// other remotes, local paths and other options alone.
func TestGroupRenameRemote(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`{"transfers":4,"backup_dir":"old:Trash"}`, `{"backup_dir":"new:Trash","transfers":4}`},
		{`{"compare_dest":["old:a","other:b","old:"]}`, `{"compare_dest":["new:a","other:b","new:"]}`},
		{`{"compare_dest":["old:a",1,"other:b"]}`, `{"compare_dest":["new:a",1,"other:b"]}`},
		{`{"copy-dest":"old,link=x:a & b"}`, `{"copy-dest":"new,link=x:a & b"}`},
		{`{"--backup-dir":"old:x"}`, `{"--backup-dir":"new:x"}`},
		{`{"backup_dir1":"old:1","backup_dir2":"old:2"}`, `{"backup_dir1":"new:1","backup_dir2":"new:2"}`},
		{`{"backup_dir":"older:x"}`, ``},
		{`{"backup_dir":"/old:x"}`, ``},
		{`{"description":"old:x"}`, ``},
		{`{"backup_dir":":local:old:x"}`, ``},
		{`{}`, ``},
	} {
		var g Group
		if err := json.Unmarshal([]byte(c.in), &g); err != nil {
			t.Fatal(err)
		}
		changed := g.RenameRemote("old", "new")
		got := marshal(g)
		want := c.want
		if want == "" {
			want = c.in
		}
		if changed != (c.want != "") || string(got) != want {
			t.Errorf("%s: got %s (changed %v), want %s", c.in, got, changed, want)
		}
	}
}
