package browse_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/rclone"
)

// The pages send one path, written as the user sees it, and use each row's path unchanged. These
// tests cover the ways a panel writes a path, and the paths it gets back.

// recorder keeps the events that an API sent, in order.
type recorder struct {
	mu     sync.Mutex
	events []any
}

func (r *recorder) emit(_ context.Context, _ string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, data)
}

// rows returns the rows that the API sent, by path, after checking that the last piece is done.
func (r *recorder) rows(t *testing.T) []browse.Row {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []browse.Row
	for i, e := range r.events {
		p := e.(browse.Rows)
		if p.Done != (i == len(r.events)-1) {
			t.Fatalf("piece %d of %d: done %v", i, len(r.events), p.Done)
		}
		out = append(out, p.Entries...)
	}
	r.events = nil
	slices.SortFunc(out, func(a, b browse.Row) int { return strings.Compare(a.Path, b.Path) })
	return out
}

func api(t *testing.T) (*browse.API, *recorder) {
	t.Helper()
	r := &recorder{}
	return browse.NewAPI(late.Of(browse.NewLister()), r.emit), r
}

func pathsOf(rows []browse.Row) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Path
	}
	return out
}

// memTree writes files into a memory bucket. files maps a slash-separated path to its content.
func memTree(t *testing.T, bucket string, files map[string]string) {
	t.Helper()
	ctx := context.Background()
	f, err := cache.Get(ctx, "mem:"+bucket)
	if err != nil {
		t.Fatal(err)
	}
	for name, text := range files {
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader(text)), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRowsCarryTheirWholePath(t *testing.T) {
	ctx := context.Background()
	a, rec := api(t)
	tree := map[string]string{"a/one.txt": "1", "a/sub/two.txt": "22", "a/.dot": "3"}
	memTree(t, "rowpaths", tree)
	local := browse.MakeTree(t, tree)
	// The machine's own form of a path: its own separator throughout, and the drive first on
	// Windows.
	under := func(names ...string) string { return filepath.Join(append([]string{local}, names...)...) }
	spelled := func(p string) string { return ":local:" + filepath.ToSlash(p) }

	cases := []struct {
		name, folder string
		want         []string
	}{
		{"a remote", "mem:rowpaths/a", []string{"mem:rowpaths/a/.dot", "mem:rowpaths/a/one.txt", "mem:rowpaths/a/sub"}},
		{"a remote, with a trailing slash", "mem:rowpaths/a/", []string{"mem:rowpaths/a/.dot", "mem:rowpaths/a/one.txt", "mem:rowpaths/a/sub"}},
		// The slash stays with the root. On sftp it is absolute, which is a different place from
		// `remote:`.
		{"a remote under its absolute root", "mem:/rowpaths/a", []string{"mem:/rowpaths/a/.dot", "mem:/rowpaths/a/one.txt", "mem:/rowpaths/a/sub"}},
		{"a local folder", under("a"), []string{under("a", ".dot"), under("a", "one.txt"), under("a", "sub")}},
		{"a local folder, with a trailing separator", under("a") + string(filepath.Separator), []string{under("a", ".dot"), under("a", "one.txt"), under("a", "sub")}},
		// The local backend written as a remote stays in that form, with rclone's `/` (and the
		// drive first on Windows).
		{":local: spelled", ":local:" + under("a"), []string{spelled(under("a", ".dot")), spelled(under("a", "one.txt")), spelled(under("a", "sub"))}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := a.List(ctx, "r", tc.folder, false, false); err != nil {
				t.Fatal(err)
			}
			got := rec.rows(t)
			if !slices.Equal(pathsOf(got), tc.want) {
				t.Fatalf("paths %q, want %q", pathsOf(got), tc.want)
			}
			if r := got[1]; r.Name != "one.txt" || r.Size != 1 || r.IsDir || r.ModTime == "" || r.Below != "" {
				t.Errorf("row %+v", r)
			}
			if !got[2].IsDir {
				t.Errorf("%s is not a folder", got[2].Path)
			}
		})
	}
}

func TestSearchRowsSayWhereBelowTheFolder(t *testing.T) {
	ctx := context.Background()
	a, rec := api(t)
	memTree(t, "searchpaths", map[string]string{"a/b/match.txt": "1", "a/match-too": "2", "other/match": "3"})
	for _, tc := range []struct{ folder, wantPath, wantBelow string }{
		{"mem:searchpaths/a", "mem:searchpaths/a/b/match.txt", "b/match.txt"},
		{"mem:/searchpaths/a/", "mem:/searchpaths/a/b/match.txt", "b/match.txt"},
		{"mem:searchpaths", "mem:searchpaths/a/b/match.txt", "a/b/match.txt"},
	} {
		if err := a.Search(ctx, "r", tc.folder, "match.", false); err != nil {
			t.Fatal(err)
		}
		got := rec.rows(t)
		if len(got) != 1 || got[0].Path != tc.wantPath || got[0].Below != tc.wantBelow || got[0].Name != "match.txt" {
			t.Errorf("%s: %+v", tc.folder, got)
		}
	}
}

func TestSizesAnswerByThePathAsked(t *testing.T) {
	ctx := context.Background()
	a, rec := api(t)
	local := browse.MakeTree(t, map[string]string{"a/one": "1", "a/sub/two": "22", "b/": ""})
	// The paths are written as a listing's rows write them: in the machine's form, or with
	// `:local:` as typed. rclone would misread a relative path as relative to the process's
	// working directory (this package's folder, where rel is), so it is left out along with the
	// folders that can't be counted.
	rel, err := os.MkdirTemp(".", "rel")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(rel) })
	asked := []string{filepath.Join(local, "a"), filepath.Join(local, "b"), filepath.Join(local, "missing"), "-bad:x",
		":local:" + filepath.Join(local, "a"), rel, ":local:" + rel}
	if err := a.Sizes(ctx, "r", asked); err != nil {
		t.Fatal(err)
	}
	got := map[string][2]int64{}
	for i, e := range rec.events {
		s := e.(browse.FolderSize)
		if s.Done != (i == len(rec.events)-1) {
			t.Fatalf("size %d of %d: done %v", i, len(rec.events), s.Done)
		}
		if !s.Done {
			got[s.Path] = [2]int64{s.Files, s.Bytes}
		}
	}
	want := map[string][2]int64{filepath.Join(local, "a"): {2, 3}, filepath.Join(local, "b"): {0, 0},
		":local:" + filepath.Join(local, "a"): {2, 3}}
	if len(got) != len(want) {
		t.Fatalf("sizes %v, want %v (a folder that can't be counted is left out)", got, want)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("%s: %v, want %v", p, got[p], w)
		}
	}
}

func TestAFolderRcloneWouldMisreadIsRefused(t *testing.T) {
	a, _ := api(t)
	for _, p := range []string{"", "-bad:x"} {
		err := a.List(context.Background(), "r", p, false, false)
		e := rclone.ErrorOf(err)
		if e.Code != errs.CodeInvalid || len(e.Fields) != 1 || e.Fields[0].Field != "path" {
			t.Errorf("%q: %+v", p, e)
		}
	}
	// A comparison's two folders are refused in the same way as a listing's. A relative folder
	// would be read from the process's working directory.
	local := browse.MakeTree(t, map[string]string{"a/one": "1"})
	for _, pair := range [][2]string{{"a", local}, {local, ":local:a"}, {local, "-bad:x"}} {
		_, err := a.Compare(context.Background(), pair[0], pair[1], false)
		if rclone.ErrorOf(err).Code != errs.CodeInvalid {
			t.Errorf("%q: %v", pair, err)
		}
	}
	if _, err := a.Compare(context.Background(), local, local, false); err != nil {
		t.Errorf("two full paths: %v", err)
	}
}

func TestSearchFolderStopsAtItsMax(t *testing.T) {
	ctx := context.Background()
	local := browse.MakeTree(t, map[string]string{"a/match-1": "1", "a/b/match-2": "2", "match-3": "3", "other": "4"})
	var rows []browse.Row
	collect := func(page []browse.Row) { rows = append(rows, page...) }
	capped, err := browse.SearchFolder(ctx, local, "MATCH", 10, false, collect)
	if err != nil || capped || len(rows) != 3 {
		t.Fatalf("all matches: %q %v %v", pathsOf(rows), capped, err)
	}
	if !slices.Contains(pathsOf(rows), filepath.Join(local, "a", "b", "match-2")) {
		t.Errorf("a match's row has its whole path: %q", pathsOf(rows))
	}
	rows = nil
	capped, err = browse.SearchFolder(ctx, local, "match", 2, false, collect)
	if err != nil || !capped || len(rows) != 2 {
		t.Errorf("at most two: %q %v %v", pathsOf(rows), capped, err)
	}
	if _, err := browse.SearchFolder(ctx, "rel", "match", 2, false, collect); rclone.ErrorOf(err).Code != errs.CodeInvalid {
		t.Errorf("a relative folder: %v", err)
	}
}

// CountFolder counts one folder and says why it can't, where Sizes leaves the folder out.
func TestCountFolder(t *testing.T) {
	ctx := context.Background()
	local := browse.MakeTree(t, map[string]string{"a/one": "1", "a/sub/two": "22", "file": "x"})
	s, err := browse.CountFolder(ctx, filepath.Join(local, "a"))
	if err != nil || s.Files != 2 || s.Bytes != 3 || s.Partial {
		t.Fatalf("count: %+v %v", s, err)
	}
	if _, err := browse.CountFolder(ctx, filepath.Join(local, "missing")); err == nil {
		t.Error("a missing folder was counted")
	}
	if _, err := browse.CountFolder(ctx, filepath.Join(local, "file")); err == nil {
		t.Error("a file was counted as a folder")
	}
	if _, err := browse.CountFolder(ctx, ""); rclone.ErrorOf(err).Code != errs.CodeInvalid {
		t.Errorf("no folder: %v", err)
	}
}
