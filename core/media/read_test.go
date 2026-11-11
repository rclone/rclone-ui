package media

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Read returns a file's start, says whether that is the whole file, and refuses what isn't a
// file.
func TestRead(t *testing.T) {
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	file := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(file, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(root, "empty.txt")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path  string
		limit int64
		data  string
		whole bool
	}{
		{file, 100, "0123456789", true},
		{file, 10, "0123456789", true},
		{file, 4, "0123", false},
		{":local:" + filepath.ToSlash(file), 4, "0123", false},
		{empty, 4, "", true},
	} {
		got, err := Read(ctx, tc.path, tc.limit)
		if err != nil || string(got.Data) != tc.data || got.Whole != tc.whole {
			t.Errorf("%s, %d bytes: %q whole %v, %v", tc.path, tc.limit, got.Data, got.Whole, err)
		}
	}
	if got, _ := Read(ctx, file, 4); got.Size != 10 || got.ModTime.IsZero() {
		t.Errorf("size and time: %+v", got)
	}
	for _, p := range []string{root, filepath.Join(root, "missing.txt")} {
		if _, err := Read(ctx, p, 4); err == nil {
			t.Errorf("%s was read as a file", p)
		}
	}
	for _, p := range []string{"", "notes.txt"} {
		if _, err := Read(ctx, p, 4); rclone.ErrorOf(err).Code != errs.CodeInvalid {
			t.Errorf("%q: %v", p, err)
		}
	}
}
