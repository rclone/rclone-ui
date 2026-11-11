package operations

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rclone/rclone-ui/core/rclone"
)

// A copy whose filter lists its files separated by NUL (files_from0) copies only those files.
// The test runs end to end, as the transfer service does. The page's form is built into a plan
// (BuildPlan), stored as the ledger stores it and read back (ParsePlan), and then run as a job in
// a stats group of its own (Plan.Run). The list's path contains a comma, which stays intact
// because a single text for a repeated flag is kept whole.
func TestFilesFrom0Copy(t *testing.T) {
	src, dst := filepath.ToSlash(t.TempDir()), filepath.ToSlash(t.TempDir())
	for _, f := range []string{"data/a.txt", "data/b.txt", "data/sub/c.txt", "data/sub/d.txt"} {
		p := filepath.Join(src, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(f), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	list := filepath.Join(t.TempDir(), "list,0.txt")
	if err := os.WriteFile(list, []byte("a.txt\x00sub/c.txt\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	listJSON, _ := json.Marshal(list)
	form := CopyArgs{
		Sources:     []string{src + "/data"},
		Destination: dst,
		Options:     groups(GroupFilter, `{"files_from0": `+string(listJSON)+`}`),
	}.Form()
	ctx := context.Background()
	built, err := BuildPlan(ctx, form)
	if err != nil {
		t.Fatal(err)
	}
	if got := built.Filter["files_from0"]; !reflect.DeepEqual(got, []any{list}) {
		t.Fatalf("files_from0 kept as %#v", got)
	}
	raw, err := json.Marshal(built)
	if err != nil {
		t.Fatal(err)
	}
	p, err := ParsePlan(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err != nil {
		t.Fatal(err)
	}

	rec := NewRecord(p)
	group := rclone.UIGroup("test", "files-from0")
	defer rclone.DeleteGroup(ctx, group)
	if _, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		return p.Run(ctx, "/opt/rcui/rcui", rec)
	}); err != nil {
		t.Fatal(err)
	}
	for _, s := range rec.Steps() {
		if !s.Ended || s.Err != nil {
			t.Fatalf("step %+v", s)
		}
	}

	var copied []string
	err = filepath.WalkDir(dst, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dst, path)
			copied = append(copied, filepath.ToSlash(rel))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"data/a.txt", "data/sub/c.txt"}; !reflect.DeepEqual(copied, want) {
		t.Errorf("copied %q, want %q", copied, want)
	}
}
