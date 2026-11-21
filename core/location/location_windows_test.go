package location

import "testing"

// On Windows a drive and a share are local roots, written with `\` or `/`, and `:local:` accepts
// them too. A backslash separates the names in a remote's path.
func TestSplitOnWindows(t *testing.T) {
	for _, tc := range []struct {
		input, root, rel string
		folder, local    bool
	}{
		{`C:\Users\me`, ":local:C:/", "Users/me", false, true},
		{"C:/Users/me/", ":local:C:/", "Users/me", true, true},
		{"C:", ":local:C:/", "", true, true},
		{`C:\`, ":local:C:/", "", true, true},
		{`c:photos`, ":local:c:/", "photos", false, true},
		{`C:\tmp\x\`, ":local:C:/", "tmp/x", true, true},
		{`\\srv\share\x`, ":local://srv/share/", "x", false, true},
		{`\\srv\share`, ":local://srv/share/", "", true, true},
		{`:local:C:\x\y`, ":local:C:/", "x/y", false, false},
		{`:local:\\srv\share\x`, ":local://srv/share/", "x", false, false},
		{`sftp:a\b\`, "sftp:", "a/b", true, false},
		{`sftp:\srv`, "sftp:/", "srv", false, false},
	} {
		at, err := Split(tc.input)
		if err != nil || at.Root() != tc.root || at.Rel != tc.rel || at.Folder != tc.folder || at.Local != tc.local {
			t.Errorf("%s: %+v %v", tc.input, at, err)
		}
	}
}

// A local path's entries use the machine's separator throughout, with the drive or share first.
// A remote's entries keep rclone's `/`.
func TestEntryOnWindows(t *testing.T) {
	for _, tc := range []struct{ folder, rel, want string }{
		{`C:\Users\me`, "Users/me/docs", `C:\Users\me\docs`},
		{"C:/Users/me/", "Users/me/docs", `C:\Users\me\docs`},
		{"C:", "docs", `C:\docs`},
		{`C:\`, "docs", `C:\docs`},
		{`\\srv\share\x`, "x/y", `\\srv\share\x\y`},
		{`:local:C:\x`, "x/y", ":local:C:/x/y"},
		{`gdrive:a\b`, "a/b/c", "gdrive:a/b/c"},
	} {
		at, err := Split(tc.folder)
		if err != nil {
			t.Fatalf("%s: %v", tc.folder, err)
		}
		if got := at.Entry(tc.rel); got != tc.want {
			t.Errorf("%s + %s: %q, want %q", tc.folder, tc.rel, got, tc.want)
		}
	}
	// On Windows a drive path means what it says.
	if got := Problem(`C:\Users\me`).String(); got != "" {
		t.Errorf("a drive path: %q", got)
	}
}

// A drive with no separator after it means the folder last used on that drive, which the
// browser and a transfer could read differently. So it isn't a full path, including on a remote
// of type local.
func TestDriveRelativeOnWindows(t *testing.T) {
	t.Setenv("RCLONE_CONFIG_MYLOCAL_TYPE", "local")
	const want = `This is not a full path. Use one that starts with a drive, as in C:\.`
	for _, in := range []string{"C:", "c:photos", `C:a\b`, `:local:D:x`, `mylocal:E:x`} {
		if got := Problem(in).String(); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
	for _, in := range []string{`C:\`, "C:/", `C:\x`, `\\srv\share`, `mylocal:C:\x`, `sftp:C:x`} {
		if got := Problem(in).String(); got != "" {
			t.Errorf("%s: %q", in, got)
		}
	}
}

// A remote of type local accepts a drive or a share as its root, as the local backend does.
// Any other remote's path is left as it is.
func TestNamedLocalRemoteOnWindows(t *testing.T) {
	t.Setenv("RCLONE_CONFIG_MYLOCAL_TYPE", "local")
	for _, tc := range []struct{ input, root, rel, entry string }{
		{`mylocal:C:\x`, "mylocal:C:/", "x", "mylocal:C:/x/y"},
		{`mylocal:\\srv\share\x`, "mylocal://srv/share/", "x", "mylocal://srv/share/x/y"},
		{`mylocal,case_insensitive:D:/x`, "mylocal,case_insensitive:D:/", "x", "mylocal,case_insensitive:D:/x/y"},
		{`sftp:C:\x`, "sftp:", "C:/x", "sftp:x/y"},
	} {
		at, err := Split(tc.input)
		if err != nil || at.Root() != tc.root || at.Rel != tc.rel || at.Local {
			t.Errorf("%s: %+v %v", tc.input, at, err)
			continue
		}
		if got := at.Entry("x/y"); got != tc.entry {
			t.Errorf("%s + x/y: %q, want %q", tc.input, got, tc.entry)
		}
	}
}
