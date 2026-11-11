package location

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/errs"
)

// pathCase is one row of testdata/paths_cases.json, the table that the frontend's lib/paths.ts
// tests read. Here it checks that the frontend parses a path the same way rclone does, and that
// Split puts the root where the table says.
type pathCase struct {
	ID    string `json:"id"`
	Input string `json:"input"`
	Host  *struct {
		Windows bool `json:"windows"`
	} `json:"host"`
	Kind    string  `json:"kind"`
	Name    *string `json:"name"`
	Path    *string `json:"path"`
	Root    *string `json:"root"`
	Rel     *string `json:"rel"`
	Problem string  `json:"problem"`
}

// rclonePrefix is the text Problem puts before rclone's own error.
const rclonePrefix = "Rclone cannot read this path: "

func TestPathCases(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/paths_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []pathCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		t.Run(c.ID, func(t *testing.T) {
			// rclone parses paths for the OS it is built for, so only that OS's rows apply.
			if (c.Host != nil && c.Host.Windows) != (runtime.GOOS == "windows") {
				t.Skip("another host's row")
			}
			parsed, err := fspath.Parse(c.Input)
			switch {
			case c.Kind == "invalid":
				if err == nil {
					t.Errorf("rclone parses it: %+v", parsed)
				}
				// The frontend writes its own sentence, and the core quotes rclone.
				if got := Problem(c.Input).String(); c.Input != "" && !strings.HasPrefix(got, rclonePrefix) {
					t.Errorf("problem %q", got)
				}
				return
			case err != nil:
				t.Fatalf("rclone refuses it: %v", err)
			case c.Kind == "local" && parsed.Name != "":
				t.Errorf("rclone reads the remote %q", parsed.Name)
			// The table keeps the path exactly as typed, and rclone turns `\` into `/` on Windows.
			case c.Kind == "remote" && (parsed.Name != *c.Name || parsed.Path != filepath.ToSlash(*c.Path)):
				t.Errorf("rclone reads name %q path %q, want %q %q", parsed.Name, parsed.Path, *c.Name, *c.Path)
			}
			// Paths that rclone accepts but would read differently are reported in the same
			// words as the frontend.
			if got := Problem(c.Input).String(); got != c.Problem {
				t.Errorf("problem %q, want %q", got, c.Problem)
			}
			if c.Root != nil {
				at, err := Split(c.Input)
				if err != nil || at.Root() != *c.Root || at.Rel != *c.Rel {
					t.Errorf("split %q %q (%v), want %q %q", at.Root(), at.Rel, err, *c.Root, *c.Rel)
				}
			}
		})
	}
}

// The Fs passed to rclone keeps the slash the user typed, and the rest is a folder when it is
// written as one.
func TestSplit(t *testing.T) {
	for _, tc := range []struct {
		input, root, rel string
		folder, local    bool
	}{
		{"sftp:/var/www/", "sftp:/", "var/www", true, false},
		{"sftp:var/www/", "sftp:", "var/www", true, false},
		{"sftp:", "sftp:", "", true, false},
		{"sftp:/", "sftp:/", "", true, false},
		{"sftp:a/file.txt", "sftp:", "a/file.txt", false, false},
		{`sftp,host="a:b":a/`, `sftp,host="a:b":`, "a", true, false},
		{"/tmp/x/", ":local:/", "tmp/x", true, true},
		{"/", ":local:/", "", true, true},
		{":local:/tmp/x", ":local:/", "tmp/x", false, false},
		// In a remote's path, `//` is two slashes, not a share.
		{"gdrive://a", "gdrive:/", "a", false, false},
	} {
		at, err := Split(tc.input)
		if err != nil || at.Root() != tc.root || at.Rel != tc.rel || at.Folder != tc.folder || at.Local != tc.local {
			t.Errorf("%s: %+v %v", tc.input, at, err)
		}
	}
	if at, _ := Split(`gdrive,chunk_size="8M":a/b.txt`); at.Name != "gdrive" || at.Params["chunk_size"] != "8M" ||
		at.Dir() != "a/b.txt/" || at.Path() != "a/b.txt" || at.Base() != "b.txt" {
		t.Errorf("pieces %+v", at)
	}
	if at, _ := Split("gdrive:"); at.Dir() != "" || at.Path() != "" || at.Base() != "" {
		t.Errorf("a root's pieces %+v", at)
	}
	if _, err := Split("-bad:x"); err == nil {
		t.Error("-bad:x splits")
	}
}

// A listing's rows keep the form of the listed folder's root. The rclone entry (relative to the
// root, with `/` between names) is put back after the root the user typed, or after the
// machine's own root for a local path.
func TestEntry(t *testing.T) {
	cases := []struct{ folder, rel, want string }{
		{"gdrive:photos", "photos/a.jpg", "gdrive:photos/a.jpg"},
		{"gdrive:", "a.jpg", "gdrive:a.jpg"},
		{"sftp:/var/www/", "var/www/index.html", "sftp:/var/www/index.html"},
		{"sftp:/", "var", "sftp:/var"},
		{":sftp,host=h:/srv", "srv/x", ":sftp,host=h:/srv/x"},
		{":local:/tmp", "tmp/x", ":local:/tmp/x"},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases, []struct{ folder, rel, want string }{
			{"/Users/me", "Users/me/docs", "/Users/me/docs"},
			{"/", "tmp", "/tmp"},
			// Outside Windows a backslash is part of a name, and it stays that way.
			{`/tmp/a\b`, `tmp/a\b/c.txt`, `/tmp/a\b/c.txt`},
			{`gdrive:a\b`, `a\b/c`, `gdrive:a\b/c`},
		}...)
	}
	for _, tc := range cases {
		at, err := Split(tc.folder)
		if err != nil {
			t.Fatalf("%s: %v", tc.folder, err)
		}
		if got := at.Entry(tc.rel); got != tc.want {
			t.Errorf("%s + %s: %q, want %q", tc.folder, tc.rel, got, tc.want)
		}
	}
}

// A path that can't be used is reported next to the field, in rclone's words.
func TestProblem(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"gdrive:photos", ""},
		{"/tmp", ""},
		{"", ""},
		{"-bad:x", rclonePrefix + "config name contains invalid characters"},
		{":sftp/x", rclonePrefix + "config name contains invalid characters"},
		{`remote,host="h:x`, rclonePrefix + "unterminated quoted config value."},
		{"remote:a\\b", ""},
	} {
		if got := Problem(tc.input).String(); !strings.HasPrefix(got, tc.want) || (tc.want == "") != (got == "") {
			t.Errorf("%s: %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestRefusal(t *testing.T) {
	for _, p := range []string{"-bad:x", "tmp", "C:/Users/me"} {
		want := Problem(p).String()
		if want == "" {
			continue // C:/Users/me on Windows
		}
		if err := Refusal(p); err == nil || err.Error() != want || !errs.Is(err) || errs.FieldOf(err) != "" {
			t.Errorf("%s: refusal %v, want %q", p, err, want)
		}
		if err := FieldRefusal("path", p); err == nil || err.Error() != want || errs.FieldOf(err) != "path" {
			t.Errorf("%s: field refusal %v, want %q", p, err, want)
		}
	}
	for _, p := range []string{"", "gdrive:x", "/tmp"} {
		if Refusal(p) != nil || FieldRefusal("path", p) != nil || !Problem(p).IsZero() {
			t.Errorf("%s is refused", p)
		}
	}
}

// A local path that isn't absolute would be read from the app's working directory, so it is
// refused, whether it is written as a plain path or with the local backend.
func TestProblemRelativeLocal(t *testing.T) {
	want := "This is not a full path. Use one that starts with /."
	full := []string{"/tmp", ":local:/tmp", ":local,case_sensitive=true:/tmp", "gdrive:x", "gdrive:"}
	relative := []string{"tmp", "./x", "~/x", ":local:x", ":local:"}
	if runtime.GOOS == "windows" {
		want = `This is not a full path. Use one that starts with a drive, as in C:\.`
		full = append(full, `C:\x`, `c:/x`, `\\srv\share\x`, `\x`)
		// A drive with no separator means the folder last used on that drive.
		relative = append(relative, `c:x`, "C:", `:local:D:x`)
	}
	for _, p := range relative {
		if got := Problem(p).String(); got != want {
			t.Errorf("%s: %q", p, got)
		}
	}
	for _, p := range full {
		if got := Problem(p).String(); got != "" {
			t.Errorf("%s: %q", p, got)
		}
	}
}

// TestRenameRemote checks the one rule that every saved path follows when a remote is renamed:
// rclone's reading of the path decides, and a connection string keeps its parameters.
func TestRenameRemote(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{"from:", "to:", true},
		{"from:dir", "to:dir", true},
		{"from:dir/sub file", "to:dir/sub file", true},
		{"from,opt=x:dir", "to,opt=x:dir", true},
		{`from,a="x:y":d`, `to,a="x:y":d`, true},
		{":from:dir", ":from:dir", false},
		{"fromage:x", "fromage:x", false},
		{"/a/from:b", "/a/from:b", false},
		{"from", "from", false},
		{"other:from:x", "other:from:x", false},
		{"from,a=\"unclosed:d", "from,a=\"unclosed:d", false},
	} {
		got, ok := RenameRemote(c.in, "from", "to")
		if got != c.want || ok != c.ok {
			t.Errorf("RenameRemote(%q) = %q, %v; want %q, %v", c.in, got, ok, c.want, c.ok)
		}
	}
	if got, ok := RenameRemote("/a/b", "", "to"); ok || got != "/a/b" {
		t.Errorf("an empty name renamed %q", got)
	}
}
