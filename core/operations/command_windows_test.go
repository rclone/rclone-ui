package operations

import (
	"slices"
	"testing"
)

// On Windows, a mount point is a local path: a drive, or a folder on a drive.
func TestMountCommandOnWindows(t *testing.T) {
	checkMounts(t, []mountCase{
		{"windows drive", MountEnv{OS: "windows"}, "X:", []string{"cmount", mountSource, "X:"}, ""},
		{"windows drive, spelled with its separator", MountEnv{OS: "windows"}, `X:\`, []string{"cmount", mountSource, "X:"}, ""},
		{"windows folder", MountEnv{OS: "windows"}, `C:\mnt\\photos\`, []string{"cmount", mountSource, "C:/mnt/photos"}, `^--volname=gdrivephotos-[0-9A-Z]$`},
	})
}

// On Windows, a drive path is a local path with the drive as its root, and a download into it
// is written with the drive's separator. A script names a file on a drive or a share by its
// plain path.
func TestDrivePathsOnWindows(t *testing.T) {
	p, err := buildCopy(CopyArgs{Sources: []string{`C:\Users\me\a.txt`, `\\srv\share\b.txt`}, Destination: `D:\in\`}, settings{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []Step{
		{Op: OpCopyFile, Src: ":local:C:/", SrcRemote: "Users/me/a.txt", Dst: ":local:D:/", DstRemote: "in/a.txt"},
		{Op: OpCopyFile, Src: ":local://srv/share/", SrcRemote: "b.txt", Dst: ":local:D:/", DstRemote: "in/b.txt"},
	}
	if len(p.Steps) != len(want) || p.Steps[0] != want[0] || p.Steps[1] != want[1] {
		t.Errorf("steps %+v", p.Steps)
	}
	commands, err := p.Commands("")
	if err != nil || len(commands) != 2 ||
		!slices.Equal(commands[0].Args, []string{"copyto", `C:\Users\me\a.txt`, `D:\in\a.txt`}) ||
		!slices.Equal(commands[1].Args, []string{"copyto", `\\srv\share\b.txt`, `D:\in\b.txt`}) {
		t.Errorf("commands %q (%v)", commands, err)
	}
	if got := (DownloadArgs{Destination: `C:\dl\`, Filename: "f.zip"}).Target(); got != `C:\dl\f.zip` {
		t.Errorf("download target %q", got)
	}
	rename := RenameArgs{Items: []RenameItem{{Path: `C:\x\old`, NewName: "new"}}}.Form()
	if _, dest := rename.Ends(); dest != `C:\x\new` {
		t.Errorf("rename target %q", dest)
	}
}
