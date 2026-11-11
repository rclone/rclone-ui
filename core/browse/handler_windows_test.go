package browse

import (
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

// On Windows, the local backend written as a remote takes a drive, and fspath.SplitFs reads a
// share as a local root. The listing's root and folder are in rclone's form, and its rows write
// the root the same way the request did.
func TestFoldersOnWindows(t *testing.T) {
	for _, tc := range []struct{ folder, root, rel, row string }{
		{`:local:C:\x`, ":local:C:/", "x", ":local:C:/x/y"},
		{`:local:C:/x/`, ":local:C:/", "x", ":local:C:/x/y"},
		{`C:\x\`, ":local:C:/", "x", `C:\x\y`},
		{`\\srv\share\x`, ":local://srv/share/", "x", `\\srv\share\x\y`},
		{`:local:\\srv\share\x`, ":local://srv/share/", "x", ":local://srv/share/x/y"},
	} {
		at, err := folderOf(tc.folder, "path", i18n.M("Specify the folder to list."))
		if err != nil || at.Root() != tc.root || at.Rel != tc.rel {
			t.Errorf("%s: %q %q (%v), want %q %q", tc.folder, at.Root(), at.Rel, err, tc.root, tc.rel)
			continue
		}
		if got := rowOf(at, Entry{Path: "x/y"}).Path; got != tc.row {
			t.Errorf("%s: row %q, want %q", tc.folder, got, tc.row)
		}
	}
}

// A change to a Windows path invalidates the listings of its folder, however each one is written.
func TestInvalidationOnWindows(t *testing.T) {
	l, _ := testLister()
	keys := [][2]string{{":local:C:/", "x"}, {":local:C:/", "y"}, {":local://srv/share/", "x"}}
	before := map[[2]string]uint64{}
	for _, k := range keys {
		before[k] = epochOf(l, k[0], k[1])
	}
	l.InvalidatePaths(`C:\x\new`, `\\srv\share\x\new`)
	var got [][2]string
	for _, k := range keys {
		if epochOf(l, k[0], k[1]) != before[k] {
			got = append(got, k)
		}
	}
	if want := [][2]string{keys[0], keys[2]}; !slices.Equal(got, want) {
		t.Errorf("invalidated %q, want %q", got, want)
	}
}
