package operations

import (
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/errs"
)

// CheckForm refuses what BuildPlan would refuse before it asks rclone about the paths, so it never
// opens a remote: gdrive isn't configured here.
func TestCheckForm(t *testing.T) {
	for _, c := range []struct {
		name  string
		form  Form
		field string // the refusal's field, or "" for a refusal without one
		want  string // the start of the refusal, or "" when the form passes
	}{
		{"a copy", CopyArgs{Sources: []string{"gdrive:a", "gdrive:b.txt"}, Destination: "/c"}.Form(), "", ""},
		{"a copy without a destination", CopyArgs{Sources: []string{"gdrive:a"}}.Form(), "",
			"Please select a destination path"},
		{"a path rclone refuses", SyncArgs{Source: "-bad:x", Destination: "/c"}.Form(), "",
			"Rclone cannot read this path"},
		{"include rules with two sources", CopyArgs{Sources: []string{"/a/", "/b/"}, Destination: "/c",
			Options: groups("filter", `{"include": ["*.jpg"]}`)}.Form(), "", "Include rules are not supported with multiple sources"},
		{"a delete of a root", DeleteArgs{Sources: []string{"gdrive:a", "gdrive:"}}.Form(), "",
			"gdrive: is the root of a remote."},
		{"a purge of a root", PurgeArgs{Sources: []string{"/"}}.Form(), "", "/ is the root of a remote."},
		{"an option rclone sets once", MoveArgs{Sources: []string{"/a"}, Destination: "/c",
			Options: groups("config", `{"bwlimit": "1M"}`)}.Form(), "options.config", "bwlimit can't be set for one transfer"},
		{"an option in the wrong group", BisyncArgs{Source: "/a", Destination: "/c",
			Options: groups("bisync", `{"max_age": "1d"}`)}.Form(), "options.bisync", "max_age is not one of the options"},
		{"a mapper without metadata", CopyArgs{Sources: []string{"/a"}, Destination: "/c",
			Options: groups("metadata", `{"metadata_mapper": ["metadata-map"]}`)}.Form(), "options.metadata", noMetadata},
		{"a mapper with metadata", CopyArgs{Sources: []string{"/a"}, Destination: "/c",
			Options: groups("metadata", `{"metadata": "true", "metadata_mapper": ["metadata-map"]}`)}.Form(), "", ""},
		{"a default turned off", CopyArgs{Sources: []string{"/a"}, Destination: "/c",
			Options: groups("config", `{"transfers": null}`)}.Form(), "", ""},
		{"a bad value", CopyArgs{Sources: []string{"/a"}, Destination: "/c",
			Options: groups("config", `{"transfers": 0}`)}.Form(), "transfers", "transfers must be at least 1"},
		{"a download named as a path", DownloadArgs{URL: "https://e/x", Filename: "a/b", Destination: "/tmp"}.Form(), "",
			"A name cannot contain"},
		{"a mount's form", MountArgs{Source: "/a", Destination: "/m"}.Form(), "", "a \"mount\" form doesn't run as a transfer"},
	} {
		err := CheckForm(c.form)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s: %v", c.name, err)
		case c.want != "" && (err == nil || !strings.HasPrefix(err.Error(), c.want)):
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		case c.want != "" && c.field != errs.FieldOf(err):
			t.Errorf("%s: on %q, want %q", c.name, errs.FieldOf(err), c.field)
		}
	}
}
