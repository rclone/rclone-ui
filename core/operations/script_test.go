package operations

import (
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// localPath returns a path in a folder on this computer, in two forms: the Fs string that a plan
// opens it by, and the plain path that a script names it by. On Windows the folder is on a drive.
// A path that starts with `/` there is on the drive that the app runs from, so it is not a full
// path, and a script keeps it as an Fs string.
func localPath(rel string) (fsString, plain string) {
	home := "/home/me/"
	if runtime.GOOS == "windows" {
		home = "C:/home/me/"
	}
	return ":local:" + home + rel, filepath.FromSlash(home + rel)
}

// A plan's steps become one rclone command each. Every command has the plan's options, a step
// that reads a folder has the filters too, and a file step names its file with copyto. A local
// path is written as a plain path, without the local backend's name.
func TestPlanCommands(t *testing.T) {
	photosFs, photos := localPath("Photos/")
	homeFs, _ := localPath("")
	_, notes := localPath("notes.txt")
	p := Plan{
		Steps: []Step{
			{Op: OpCopy, Src: photosFs, Dst: "gdrive:Backup/Photos", CreateEmptySrcDirs: true},
			{Op: OpCopyFile, Src: homeFs, SrcRemote: "notes.txt", Dst: "gdrive:Backup", DstRemote: "notes.txt"},
		},
		Config: Options{"transfers": 8},
		Filter: Options{"exclude": []any{"*.tmp"}},
	}
	got, err := p.Commands("/opt/rcui")
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"copy", photos, "gdrive:Backup/Photos", "--create-empty-src-dirs", "--transfers=8", "--exclude=*.tmp"},
		{"copyto", notes, "gdrive:Backup/notes.txt", "--transfers=8"},
	}
	if len(got) != len(want) {
		t.Fatalf("commands %q", got)
	}
	for i := range want {
		if !slices.Equal(got[i].Args, want[i]) {
			t.Errorf("command %d: %q, want %q", i, got[i].Args, want[i])
		}
	}
}

// A bisync's parameters become the flags of rclone bisync. A switch that is off, and the share of
// deletes at the command line's own default, are left out.
func TestBisyncCommand(t *testing.T) {
	p := Plan{
		Steps: []Step{{Op: OpBisync, Src: "/home/me/Notes", Dst: "gdrive:Notes"}},
		Bisync: map[string]any{
			"resync": true, "force": false, "maxDelete": defaultMaxDelete,
			"conflictResolve": "newer", "backupDir1": "/home/me/old",
		},
	}
	got, err := p.Commands("")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"bisync", "/home/me/Notes", "gdrive:Notes",
		"--backup-dir1=/home/me/old", "--conflict-resolve=newer", "--resync",
	}
	if len(got) != 1 || !slices.Equal(got[0].Args, want) {
		t.Fatalf("command %q, want %q", got, want)
	}
}

// A script's lines quote what each shell would read differently, and only a flag's value. A
// serve's credentials are variables: in front of the command in a POSIX shell, and on a line of
// their own in PowerShell. A config file other than rclone's default is named with --config.
func TestScriptLines(t *testing.T) {
	commands := []ScriptCommand{
		{Args: []string{"copy", "/home/me/My Files", "gdrive:it's", "--exclude=*.tmp"}},
		{Args: []string{"serve", "webdav", "gdrive,chunk_size=64M:"}, Env: []string{"RCLONE_PASS=s3cret pass"}},
	}
	posix := ScriptLines(commands, "darwin", "")
	wantPOSIX := []string{
		`rclone copy '/home/me/My Files' 'gdrive:it'\''s' --exclude='*.tmp'`,
		`RCLONE_PASS='s3cret pass' rclone serve webdav gdrive,chunk_size=64M:`,
	}
	if !slices.Equal(posix, wantPOSIX) {
		t.Errorf("POSIX lines %q, want %q", posix, wantPOSIX)
	}
	powerShell := ScriptLines(commands, "windows", `C:\Users\me\rclone.conf`)
	wantPowerShell := []string{
		`rclone copy '/home/me/My Files' 'gdrive:it''s' --exclude='*.tmp' --config=C:\Users\me\rclone.conf`,
		`$env:RCLONE_PASS = 's3cret pass'`,
		`rclone serve webdav 'gdrive,chunk_size=64M:' --config=C:\Users\me\rclone.conf`,
	}
	if !slices.Equal(powerShell, wantPowerShell) {
		t.Errorf("PowerShell lines %q, want %q", powerShell, wantPowerShell)
	}
}

// A script's mount has the page's flags, but neither the NFS port nor the cache folder that the
// app picks for its own mounts.
func TestMountScript(t *testing.T) {
	c, err := mountCommand(MountArgs{
		Source:      "gdrive:photos",
		Destination: "/Volumes/photos",
		Options:     groups("vfs", `{"vfs_cache_mode": "full"}`),
	}, MountEnv{OS: "darwin", CacheRoot: "/data/cache"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.Args[:3], []string{"nfsmount", "gdrive:photos/", "/Volumes/photos"}) {
		t.Fatalf("args %q", c.Args)
	}
	if !slices.Contains(c.Args, "--vfs-cache-mode=full") {
		t.Errorf("args %q have no --vfs-cache-mode", c.Args)
	}
	for _, arg := range c.Args {
		if strings.HasPrefix(arg, "--addr=") || strings.HasPrefix(arg, "--cache-dir=") {
			t.Errorf("args %q have the app's %s", c.Args, arg)
		}
	}
}

// A script's serve keeps its credentials out of the command line, as the app's own serve does,
// and serves a local folder by its plain path.
func TestServeScript(t *testing.T) {
	_, shared := localPath("Shared")
	_, sharedFolder := localPath("Shared/")
	c, err := serveCommand(ServeArgs{
		Source:  shared,
		Type:    "webdav",
		Options: groups("serve", `{"user": "me", "pass": "s3cret"}`),
	}, ServeEnv{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.Args[:3], []string{"serve", "webdav", sharedFolder}) {
		t.Fatalf("args %q", c.Args)
	}
	if !slices.Contains(c.Args, "--user=me") || slices.ContainsFunc(c.Args, func(a string) bool { return strings.Contains(a, "s3cret") }) {
		t.Errorf("args %q", c.Args)
	}
	if !slices.Equal(c.Env, []string{"RCLONE_PASS=s3cret"}) {
		t.Errorf("env %q", c.Env)
	}
}

// A plan's program runs each step as its API call, in the background, and waits for it. The
// options are in _config and the filters in _filter, keyed by the fields of rclone's structs,
// with each value in the JSON type that rclone reads.
func TestPlanProgram(t *testing.T) {
	photosFs, photos := localPath("Photos/")
	homeFs, _ := localPath("")
	p := Plan{
		Steps: []Step{
			{Op: OpCopy, Src: photosFs, Dst: "gdrive:Backup/Photos", CreateEmptySrcDirs: true},
			{Op: OpCopyFile, Src: homeFs, SrcRemote: "it's.txt", Dst: "gdrive:Backup", DstRemote: "it's.txt"},
		},
		Config: Options{"transfers": "8", "buffer_size": "32M", "fast_list": "true"},
		Filter: Options{"exclude": []any{"*.tmp"}},
	}
	script, err := p.Script("", "darwin", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"import createRCDClient from 'rclone-sdk'",
		"started with: rclone rcd --rc-no-auth\n",
		"async function run(",
		"    rcd.ASYNC('/sync/copy', {\n        body: {\n            srcFs: " + jsString(photos) + ",\n            dstFs: 'gdrive:Backup/Photos',\n            createEmptySrcDirs: true,\n            _config: {\n                BufferSize: '32M',\n                UseListR: true,\n                Transfers: 8,\n            },\n            _filter: {\n                ExcludeRule: ['*.tmp'],\n            },\n        },\n    })",
		"srcRemote: 'it\\'s.txt',",
	} {
		if !strings.Contains(script.SDK, want) {
			t.Errorf("program has no %q:\n%s", want, script.SDK)
		}
	}
	// A file step has no filters.
	if strings.Count(script.SDK, "_filter") != 1 {
		t.Errorf("program:\n%s", script.SDK)
	}
}

// A mount's program and a serve's are one call each, with their own options as parameters named
// as rclone names them, and the serve's credentials among them.
func TestMountAndServePrograms(t *testing.T) {
	mount, err := MountScript(MountArgs{
		Source:      "gdrive:photos",
		Destination: "/Volumes/photos",
		Options:     groups("vfs", `{"vfs_cache_mode": "full"}`),
	}, MountEnv{OS: "darwin"}, "/home/me/rclone.conf")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--config=/home/me/rclone.conf\n",
		"rcd.POST('/mount/mount', {\n    body: {\n        fs: 'gdrive:photos/',\n        mountPoint: '/Volumes/photos',\n        mountType: 'nfsmount',\n",
		"        vfs_cache_mode: 'full',\n",
	} {
		if !strings.Contains(mount.SDK, want) {
			t.Errorf("mount program has no %q:\n%s", want, mount.SDK)
		}
	}
	if strings.Contains(mount.SDK, "async function run(") {
		t.Errorf("mount program waits for a job:\n%s", mount.SDK)
	}
	_, shared := localPath("Shared")
	_, sharedFolder := localPath("Shared/")
	serve, err := ServeScript(ServeArgs{
		Source:  shared,
		Type:    "webdav",
		Options: groups("serve", `{"user": "me", "pass": "s3cret"}`),
	}, ServeEnv{}, "darwin", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"type: 'webdav',", "fs: " + jsString(sharedFolder) + ",", "pass: 's3cret',", "user: 'me',", "console.log('Serving on', data.addr)"} {
		if !strings.Contains(serve.SDK, want) {
			t.Errorf("serve program has no %q:\n%s", want, serve.SDK)
		}
	}
}
