package agents

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/transfers"
)

// fileTree writes files under a new temporary folder and returns its real path. files maps a
// slash-separated path to its content, and a path that ends in / is an empty folder.
func fileTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// onBox returns a local path as a path on the tests' remote, box.
func onBox(p string) string { return "box:" + filepath.ToSlash(p) }

// entryNames returns the names of entries, in their order.
func entryNames(entries []fileEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name
	}
	return out
}

// shortWalks makes searches and counts stop at once, until the test ends.
func shortWalks(t *testing.T) {
	was := walkFor
	walkFor = time.Nanosecond
	t.Cleanup(func() { walkFor = was })
}

// A folder's entries come folders first, then by name, each with its full path, and the list
// stops at the limit.
func TestListFiles(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{"b.txt": "bb", "A.txt": "a", "c/": "", "B/": "", ".hidden": "h"})
	out := must[listFilesOut](t, cs, "list_files", map[string]any{"path": onBox(root)})
	if want := []string{"B", "c", ".hidden", "A.txt", "b.txt"}; !slices.Equal(entryNames(out.Entries), want) || out.Total != 5 || out.Truncated {
		t.Fatalf("entries %q (total %d), want %q", entryNames(out.Entries), out.Total, want)
	}
	folder, file := out.Entries[0], out.Entries[3]
	if !folder.IsFolder || folder.Size != nil || folder.Path != onBox(root)+"/B" {
		t.Errorf("a folder: %+v", folder)
	}
	if _, err := time.Parse(time.RFC3339, file.Modified); file.IsFolder || file.Size == nil || *file.Size != 1 || err != nil {
		t.Errorf("a file: %+v", file)
	}

	// The listing is read again each time, so a file that the agent wrote by other means shows
	// at once.
	if err := os.WriteFile(filepath.Join(root, "d.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	out = must[listFilesOut](t, cs, "list_files", map[string]any{"path": onBox(root), "limit": 2})
	if len(out.Entries) != 2 || out.Total != 6 || !out.Truncated || out.Note == "" {
		t.Errorf("at most two, after a new file: %+v", out)
	}
	// A local path's entries have local paths.
	out = must[listFilesOut](t, cs, "list_files", map[string]any{"path": root})
	if out.Total != 6 || out.Entries[0].Path != filepath.Join(root, "B") {
		t.Errorf("a local folder: %+v", out)
	}

	for _, p := range []string{filepath.Join(root, "missing"), filepath.Join(root, "A.txt"), "relative/folder", ""} {
		if _, failed := call[listFilesOut](t, cs, "list_files", map[string]any{"path": p}); failed == "" {
			t.Errorf("%q was listed", p)
		}
	}
}

// A search finds names at any depth, ignoring case and what starts with a dot, and stops at the
// limit or when its time is up.
func TestSearchFiles(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{
		"docs/Report.txt": "1", "docs/old/report-2023.md": "2", "notes.txt": "3", ".git/report": "4", "reports/": "",
	})
	out := must[searchFilesOut](t, cs, "search_files", map[string]any{"path": onBox(root), "query": "REPORT"})
	var paths []string
	for _, m := range out.Matches {
		paths = append(paths, m.Path)
	}
	want := []string{onBox(root) + "/docs/old/report-2023.md", onBox(root) + "/docs/Report.txt", onBox(root) + "/reports"}
	if !slices.Equal(paths, want) || out.Truncated || out.StoppedEarly {
		t.Fatalf("matches %q, want %q: %+v", paths, want, out)
	}
	if !out.Matches[2].IsFolder || out.Matches[1].Size == nil {
		t.Errorf("matches %+v", out.Matches)
	}

	out = must[searchFilesOut](t, cs, "search_files", map[string]any{"path": root, "query": "report", "limit": 1})
	if len(out.Matches) != 1 || !out.Truncated || out.Note == "" {
		t.Errorf("at most one: %+v", out)
	}
	if _, failed := call[searchFilesOut](t, cs, "search_files", map[string]any{"path": root, "query": ""}); failed == "" {
		t.Error("an empty query was searched")
	}

	shortWalks(t)
	out = must[searchFilesOut](t, cs, "search_files", map[string]any{"path": root, "query": "report"})
	if !out.StoppedEarly || !strings.Contains(out.Note, "stopped") {
		t.Errorf("a search out of time: %+v", out)
	}
}

// A folder's size counts everything below it, and says when the count stopped early.
func TestFolderSize(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{"a/one": "1", "a/sub/two": "22", "b/": ""})
	out := must[folderSizeOut](t, cs, "folder_size", map[string]any{"path": onBox(filepath.Join(root, "a"))})
	if out.Files != 2 || out.Bytes != 3 || !out.Complete || out.Note != "" {
		t.Errorf("a folder: %+v", out)
	}
	if _, failed := call[folderSizeOut](t, cs, "folder_size", map[string]any{"path": filepath.Join(root, "missing")}); failed == "" {
		t.Error("a missing folder was counted")
	}
	shortWalks(t)
	if out := must[folderSizeOut](t, cs, "folder_size", map[string]any{"path": root}); out.Complete || out.Note == "" {
		t.Errorf("a count out of time: %+v", out)
	}
}

// Two folders compare one level deep, with counts for every class and lists that stop at the
// limit.
func TestCompareFolders(t *testing.T) {
	cs := connect(t)
	left := fileTree(t, map[string]string{"same.txt": "x", "diff.txt": "aaa", "mine.txt": "l", "both/": "", "lonely/": "", "kind": "a file"})
	right := fileTree(t, map[string]string{"same.txt": "x", "diff.txt": "bbbb", "theirs.txt": "r", "both/": "", "kind/": ""})
	out := must[compareFoldersOut](t, cs, "compare_folders", map[string]any{"left": left, "right": onBox(right)})
	if want := (comparedCounts{OnlyLeft: 2, OnlyRight: 1, Different: 2, Same: 1, FoldersInBoth: 1}); out.Counts != want {
		t.Fatalf("counts %+v, want %+v", out.Counts, want)
	}
	if len(out.OnlyLeft) != 2 || !out.OnlyLeft[0].IsFolder || out.OnlyLeft[0].Name != "lonely" || out.OnlyRight[0].Name != "theirs.txt" {
		t.Errorf("only on one side: %+v %+v", out.OnlyLeft, out.OnlyRight)
	}
	var diff comparedPair
	for _, p := range out.Different {
		if p.Name == "diff.txt" {
			diff = p
		}
	}
	if diff.LeftSize == nil || *diff.LeftSize != 3 || diff.RightSize == nil || *diff.RightSize != 4 || diff.LeftModified == "" {
		t.Errorf("a file that differs: %+v", diff)
	}
	if out.Truncated || out.StoppedEarly {
		t.Errorf("nothing was cut: %+v", out)
	}

	out = must[compareFoldersOut](t, cs, "compare_folders", map[string]any{"left": left, "right": right, "limit": 1})
	if len(out.OnlyLeft) != 1 || out.Counts.OnlyLeft != 2 || !out.Truncated || out.Note == "" {
		t.Errorf("at most one name a list: %+v", out)
	}
	if _, failed := call[compareFoldersOut](t, cs, "compare_folders", map[string]any{"left": left, "right": filepath.Join(right, "missing")}); failed == "" {
		t.Error("a missing folder was compared")
	}
}

// A local disk can't make public links, and a root is no entry to link to.
func TestPublicLinkRefusals(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{"a.txt": "a"})
	for _, p := range []string{filepath.Join(root, "a.txt"), "box:"} {
		if _, failed := call[publicLinkOut](t, cs, "get_public_link", map[string]any{"path": p}); failed == "" {
			t.Errorf("%s got a link", p)
		}
	}
}

// A text file reads whole or as its start, cut between characters, and a file that isn't text
// is refused.
func TestReadFile(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{
		"notes.txt": "hello\nworld", "accent.txt": "hé!", "binary.bin": "\xff\xfe\x01", "nul.txt": "a\x00b",
		"big.txt": strings.Repeat("a", readMax+10), "folder/": "",
	})
	out := must[readFileOut](t, cs, "read_file", map[string]any{"path": onBox(filepath.Join(root, "notes.txt"))})
	if out.Text != "hello\nworld" || out.Truncated || out.Size == nil || *out.Size != 11 || out.Modified == "" {
		t.Errorf("a whole file: %+v", out)
	}
	out = must[readFileOut](t, cs, "read_file", map[string]any{"path": filepath.Join(root, "notes.txt"), "max_bytes": 5})
	if out.Text != "hello" || !out.Truncated {
		t.Errorf("a file's start: %+v", out)
	}
	// é is two bytes, and the read stops after its first.
	out = must[readFileOut](t, cs, "read_file", map[string]any{"path": filepath.Join(root, "accent.txt"), "max_bytes": 2})
	if out.Text != "h" || !out.Truncated {
		t.Errorf("a character cut in two: %+v", out)
	}
	out = must[readFileOut](t, cs, "read_file", map[string]any{"path": filepath.Join(root, "big.txt"), "max_bytes": 1 << 30})
	if len(out.Text) != readMax || !out.Truncated || *out.Size != readMax+10 {
		t.Errorf("a large file: %d bytes, %+v %v", len(out.Text), out.Truncated, out.Size)
	}
	for _, name := range []string{"binary.bin", "nul.txt"} {
		if _, failed := call[readFileOut](t, cs, "read_file", map[string]any{"path": filepath.Join(root, name)}); !strings.Contains(failed, "isn't text") {
			t.Errorf("%s: %q", name, failed)
		}
	}
	for _, name := range []string{"folder", "missing.txt"} {
		if _, failed := call[readFileOut](t, cs, "read_file", map[string]any{"path": filepath.Join(root, name)}); failed == "" {
			t.Errorf("%s was read", name)
		}
	}
}

// A folder is made, a file is renamed at once, and a folder by the agent's transfer. Neither
// overwrites what is there.
func TestMakeFolderAndRename(t *testing.T) {
	cs := connect(t)
	root := fileTree(t, map[string]string{"a.txt": "a", "taken.txt": "t", "full/in.txt": "x"})
	made := must[madeFolder](t, cs, "make_folder", map[string]any{"path": onBox(filepath.Join(root, "new"))})
	if info, err := os.Stat(filepath.Join(root, "new")); err != nil || !info.IsDir() || made.Path != onBox(filepath.Join(root, "new")) {
		t.Fatalf("make_folder: %+v %v", made, err)
	}
	if _, failed := call[madeFolder](t, cs, "make_folder", map[string]any{"path": filepath.Join(root, "new")}); !strings.Contains(failed, "already exists") {
		t.Errorf("a folder made twice: %q", failed)
	}

	out := must[renamed](t, cs, "rename", map[string]any{"path": filepath.Join(root, "a.txt"), "new_name": "b.txt"})
	if out.Path != filepath.Join(root, "b.txt") || out.TransferID != "" || !fileExists(filepath.Join(root, "b.txt")) || fileExists(filepath.Join(root, "a.txt")) {
		t.Errorf("a file renamed: %+v", out)
	}
	for _, tc := range []struct{ path, name, says string }{
		{filepath.Join(root, "b.txt"), "taken.txt", "already exists"},
		{filepath.Join(root, "b.txt"), "x/y.txt", "cannot contain"},
		{filepath.Join(root, "missing.txt"), "c.txt", "doesn't exist"},
	} {
		if _, failed := call[renamed](t, cs, "rename", map[string]any{"path": tc.path, "new_name": tc.name}); !strings.Contains(failed, tc.says) {
			t.Errorf("%s to %s: %q, want %q", tc.path, tc.name, failed, tc.says)
		}
	}

	out = must[renamed](t, cs, "rename", map[string]any{"path": onBox(filepath.Join(root, "full")), "new_name": "moved"})
	if out.TransferID == "" || out.Path != onBox(filepath.Join(root, "moved")) {
		t.Fatalf("a folder renamed: %+v", out)
	}
	d := awaitRename(t, out.TransferID)
	if d.State != transfers.StateCompleted || d.Origin.Kind != transfers.OriginAgent || !fileExists(filepath.Join(root, "moved", "in.txt")) || fileExists(filepath.Join(root, "full")) {
		t.Errorf("the folder's rename: %s %+v", d.State, d.Origin)
	}
}

// fileExists reports whether path is on disk.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// awaitRename waits for the transfer that renames a folder to end, and returns it.
func awaitRename(t *testing.T, id string) transfers.Detail {
	t.Helper()
	ctx := context.Background()
	for range 300 {
		d, err := apis.Transfers.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if d.EndedAt != nil {
			return d
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("%s is still running after 30 seconds", id)
	return transfers.Detail{}
}

// An operation's options come in its window's groups, with the app's defaults, and a search
// narrows them.
func TestListOptions(t *testing.T) {
	cs := connect(t)
	optionIn := func(out optionsListed, group, name string) *optionInfo {
		for _, g := range out.Groups {
			if g.Name != group {
				continue
			}
			for i := range g.Options {
				if g.Options[i].Name == name {
					return &g.Options[i]
				}
			}
		}
		return nil
	}
	groups := func(out optionsListed) []string {
		var names []string
		for _, g := range out.Groups {
			names = append(names, g.Name)
		}
		return names
	}

	out := must[optionsListed](t, cs, "list_options", map[string]any{"operation": "copy"})
	if want := []string{"copy", "filter", "config", "metadata"}; !slices.Equal(groups(out), want) {
		t.Errorf("copy's groups %q, want %q", groups(out), want)
	}
	if o := optionIn(out, "config", "transfers"); o == nil || o.Default != "8" || o.Type != "int" || o.Help == "" || strings.Contains(o.Help, "\n") {
		t.Errorf("transfers, whose default is the app's: %+v", o)
	}
	if o := optionIn(out, "filter", "max_age"); o == nil || o.Type != "duration" {
		t.Errorf("max_age: %+v", o)
	}
	if optionIn(out, "copy", "backup_dir") == nil {
		t.Error("a copy's own group has no backup_dir")
	}

	out = must[optionsListed](t, cs, "list_options", map[string]any{"operation": "copy", "search": "max-age"})
	if o := optionIn(out, "filter", "max_age"); o == nil {
		t.Errorf("a search for max-age: %+v", out)
	}
	for _, g := range out.Groups {
		for _, o := range g.Options {
			if !strings.Contains(o.Name, "max_age") && !strings.Contains(strings.ToLower(o.Help), "max-age") {
				t.Errorf("%s matches the search for max-age? %+v", g.Name, o)
			}
		}
	}

	out = must[optionsListed](t, cs, "list_options", map[string]any{"operation": "mount"})
	if o := optionIn(out, "vfs", "vfs_cache_mode"); o == nil || o.Default != "off" || !slices.Contains(o.Choices, "full") {
		t.Errorf("vfs_cache_mode: %+v", o)
	}
	out = must[optionsListed](t, cs, "list_options", map[string]any{"operation": "serve", "serve_type": "http"})
	if optionIn(out, "serve", "addr") == nil || optionIn(out, "serve", "auth_key") != nil {
		t.Errorf("an http serve's group: %+v", out.Groups[0])
	}
	if out := must[optionsListed](t, cs, "list_options", map[string]any{"operation": "download"}); !slices.Equal(groups(out), []string{"config"}) {
		t.Errorf("a download's groups: %q", groups(out))
	}
	for _, args := range []map[string]any{{"operation": "rename"}, {"operation": "serve", "serve_type": "gopher"}} {
		if _, failed := call[optionsListed](t, cs, "list_options", args); failed == "" {
			t.Errorf("%v was listed", args)
		}
	}
}

// The help of an option is cut to its first sentence, but not at an abbreviation.
func TestFirstSentence(t *testing.T) {
	for help, want := range map[string]string{
		"Number of file transfers to run in parallel": "Number of file transfers to run in parallel",
		"Skip files. Then more.":                      "Skip files.",
		"Use a size, e.g. 10M. Then more.":            "Use a size, e.g. 10M.",
		"First line\n\nA second paragraph.":           "First line",
		"  Trimmed.\n":                                "Trimmed.",
		"Ends with a dot.":                            "Ends with a dot.",
		"Several i.e. abbreviations etc. are kept. And this is the second.": "Several i.e. abbreviations etc. are kept.",
	} {
		if got := firstSentence(help); got != want {
			t.Errorf("%q: %q, want %q", help, got, want)
		}
	}
}
