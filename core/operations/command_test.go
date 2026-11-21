package operations

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/catalog"
)

// mountCase is one mount's command line. It holds the environment, the mount point as the page
// gives it, the start of the command line (command, Fs, mount point, then the platform's own
// flags), and a pattern for the volname flag ("" for none).
type mountCase struct {
	name        string
	env         MountEnv
	destination string
	head        []string
	volname     string
}

// mountSource is the Fs of every mountCase: gdrive:photos with the override from the remotes
// group.
const mountSource = `gdrive,chunk_size='64M':photos/`

// checkMounts builds each case's mount of gdrive:photos with the same groups. After the start of
// the command line come the cache folder and the volname, and then each group's flags, sorted by
// name: mount, VFS, main options and filters. The app's defaults would be among them, but the
// config group names both: transfers with its own value, and checkers with a blank one.
func checkMounts(t *testing.T, cases []mountCase) {
	t.Helper()
	options := groups(
		"mount", `{"allow_other": true, "volname": ""}`,
		"vfs", `{"vfs_cache_mode": "full", "dir_cache_time": "5m", "vfs_cache_max_size": "10G"}`,
		"config", `{"transfers": 4, "checkers": "  "}`,
		"filter", `{"exclude": ["*.tmp", "*.bak"]}`,
		"metadata", `{"metadata": true, "metadata_mapper": ["metadata-map", "--map", "a=b"], "metadata_include": "k=v"}`,
		"remotes", `{"gdrive": {"chunk_size": "64M"}}`,
	)
	flags := []string{
		"--allow-other=true", "--dir-cache-time=5m", "--vfs-cache-max-size=10G",
		"--vfs-cache-mode=full", "--metadata=true",
		`--metadata-mapper="/opt/rclone cloud/rcc" metadata-map --map a=b`, "--transfers=4",
		"--exclude=*.tmp", "--exclude=*.bak", "--metadata-include=k=v",
	}
	hash := regexp.MustCompile(`^/data/cache/vfs/[0-9a-f]{16}$`)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.env.Exe, tc.env.CacheRoot = "/opt/rclone cloud/rcc", "/data/cache"
			m, err := MountCommand(MountArgs{Source: "gdrive:photos", Destination: tc.destination, Options: options}, tc.env)
			if err != nil {
				t.Fatal(err)
			}
			args := m.Args
			if !slices.Equal(args[:len(tc.head)], tc.head) {
				t.Fatalf("args %q", args)
			}
			args = args[len(tc.head):]
			cacheDir := filepath.ToSlash(strings.TrimPrefix(args[0], "--cache-dir="))
			if !strings.HasPrefix(args[0], "--cache-dir=") || !hash.MatchString(cacheDir) ||
				m.CacheDir != strings.TrimPrefix(args[0], "--cache-dir=") {
				t.Fatalf("cache dir %q", args[0])
			}
			args = args[1:]
			if tc.volname != "" {
				if !regexp.MustCompile(tc.volname).MatchString(args[1]) {
					t.Fatalf("volname %q", args[1])
				}
				args = slices.Delete(args, 1, 2)
			}
			if !slices.Equal(args, flags) {
				t.Fatalf("flags\n got %q\nwant %q", args, flags)
			}
			if m.MountPoint != tc.head[2] || m.Source != tc.head[1] {
				t.Fatalf("mount point %q source %q", m.MountPoint, m.Source)
			}
		})
	}
}

func TestMountCommand(t *testing.T) {
	cases := []mountCase{
		{"windows drive picked by rclone", MountEnv{OS: "windows"}, "*", []string{"cmount", mountSource, "*"}, ""},
	}
	if runtime.GOOS != "windows" {
		// These paths are only valid on the OS that rclone is built for.
		cases = append(cases,
			mountCase{"linux", MountEnv{OS: "linux"}, "/mnt/photos/", []string{"mount", mountSource, "/mnt/photos"}, ""},
			mountCase{"cleaned", MountEnv{OS: "linux"}, "/mnt//photos/./", []string{"mount", mountSource, "/mnt/photos"}, ""},
			mountCase{"macos", MountEnv{OS: "darwin", NFSPort: 1234}, "/Volumes/x", []string{"nfsmount", mountSource, "/Volumes/x", "--addr=127.0.0.1:1234"}, `^--volname=gdrivephotos-[0-9A-Z]$`},
		)
	}
	checkMounts(t, cases)
}

func TestMountCommandStable(t *testing.T) {
	env := MountEnv{OS: "darwin", NFSPort: 1, CacheRoot: "/c"}
	g := groups("vfs", `{"vfs_cache_mode": "full", "read_only": true, "dir_cache_time": "1m"}`)
	a, _ := MountCommand(MountArgs{Source: "gdrive:x", Destination: "/m", Options: g}, env)
	b, _ := MountCommand(MountArgs{Source: "gdrive:x", Destination: "/m", Options: g}, env)
	c, _ := MountCommand(MountArgs{Source: "gdrive:x", Destination: "/n", Options: g}, env)
	if a.CacheDir != b.CacheDir || !slices.Equal(a.Args, b.Args) || a.CacheDir == c.CacheDir {
		t.Fatalf("cache dirs %s %s %s", a.CacheDir, b.CacheDir, c.CacheDir)
	}
	// A gdrive remote in another config file (after the file moved) may be another account, so
	// its uploads wait in a separate folder.
	other := env
	other.Config = "/home/me/work.conf"
	if d, _ := MountCommand(MountArgs{Source: "gdrive:x", Destination: "/m", Options: g}, other); d.CacheDir == a.CacheDir {
		t.Fatalf("two configs' gdrive:x at /m share %s", d.CacheDir)
	}
}

func TestCommandRefusals(t *testing.T) {
	mount := func(g Groups, dest string) error {
		_, err := MountCommand(MountArgs{Source: "gdrive:", Destination: dest, Options: g}, MountEnv{OS: "linux"})
		return err
	}
	serve := func(typ string, g Groups) error {
		_, err := ServeCommand(ServeArgs{Type: typ, Source: "gdrive:", Options: g}, ServeEnv{})
		return err
	}
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"an option of another block", mount(groups("mount", `{"transfers": 4}`), "/m"), "‘transfers’ is not one of the mount options"},
		{"a flag the app sets", mount(groups("config", `{"bwlimit": "1M"}`), "/m"), "bwlimit applies to the whole app"},
		{"a daemon", mount(groups("mount", `{"daemon": true}`), "/m"), "daemon cannot be used here"},
		{"the rc block", mount(groups("config", `{"rc_addr": ":5572"}`), "/m"), "‘rc_addr’ is not one of the config options"},
		{"a bad value", mount(groups("vfs", `{"vfs_cache_mode": "most"}`), "/m"), "vfs_cache_mode"},
		{"a typed value of the wrong type", mount(groups("vfs", `{"read_only": 3}`), "/m"), `read_only: parsing "3" as bool`},
		{"a list for one value", mount(groups("vfs", `{"vfs_cache_mode": ["full"]}`), "/m"), "vfs_cache_mode: takes one value"},
		{"two spellings of one option", mount(groups("vfs", `{"read-only": true, "read_only": false}`), "/m"), "are the same option"},
		{"a mount point on a remote", mount(Groups{}, "gdrive:x"), "The mount point must be a folder on this computer"},
		{"an override key that would write another option", mount(groups("remotes", `{"gdrive": {"a='x',ssh": "y"}}`), "/m"), "cannot be an option of gdrive"},
		{"an unknown serve type", serve("gopher", Groups{}), "Serving over gopher isn't available on this computer"},
		{"another serve type's option", serve("ftp", groups("serve", `{"htpasswd": "/x"}`)), "‘htpasswd’ is not one of the serve options"},
		{"serving over stdio", serve("sftp", groups("serve", `{"stdio": true}`)), "stdio cannot be used here"},
	} {
		if tc.err == nil || !strings.Contains(tc.err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", tc.name, tc.err, tc.want)
		}
	}
}

func TestServeCommand(t *testing.T) {
	g := groups(
		"serve", `{"addr": "127.0.0.1:0", "user": "me", "auth_proxy": ""}`,
		"vfs", `{"read_only": true}`,
		"config", `{"checkers": 2}`,
		"remotes", `{"gdrive": {"shared_with_me": true}}`,
	)
	s, err := ServeCommand(ServeArgs{Type: "webdav", Source: "gdrive:photos", Addr: "127.0.0.1:8081", Options: g}, ServeEnv{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"serve", "webdav", `gdrive,shared_with_me='true':photos/`, "--addr=127.0.0.1:8081", "--user=me",
		"--read-only=true", "--checkers=2", "--transfers=8"}
	if !slices.Equal(s.Args, want) || s.Addr != "127.0.0.1:8081" {
		t.Fatalf("args %q addr %q", s.Args, s.Addr)
	}
	// Without its own address, the serve uses the group's address, or else rclone's default.
	s, _ = ServeCommand(ServeArgs{Type: "http", Source: "/srv", Options: groups("serve", `{"addr": ["127.0.0.1:0"]}`)}, ServeEnv{})
	if s.Addr != "127.0.0.1:0" || !slices.Equal(s.Args, append([]string{"serve", "http", ":local:/srv/", "--addr=127.0.0.1:0"}, serveDefaultFlags...)) {
		t.Fatalf("args %q addr %q", s.Args, s.Addr)
	}
	s, _ = ServeCommand(ServeArgs{Type: "ftp", Source: "/srv"}, ServeEnv{})
	if s.Addr != "localhost:2121" || !slices.Equal(s.Addrs, []string{"localhost:2121"}) {
		t.Fatalf("default addr %q %q", s.Addr, s.Addrs)
	}
	// Addrs lists every address of the group, the first one first.
	s, _ = ServeCommand(ServeArgs{Type: "http", Source: "/srv", Options: groups("serve", `{"addr": ["127.0.0.1:9001", ":9002"]}`)}, ServeEnv{})
	if s.Addr != "127.0.0.1:9001" || !slices.Equal(s.Addrs, []string{"127.0.0.1:9001", ":9002"}) {
		t.Fatalf("several addresses %q %q", s.Addr, s.Addrs)
	}
}

// TestServeSecretsGoToTheEnvironment checks that a serve's password and s3 key pairs move from
// its command line to its environment, where rclone reads them (a list as one CSV record). The
// user name and every other flag stay on the command line.
func TestServeSecretsGoToTheEnvironment(t *testing.T) {
	for _, tc := range []struct {
		name    string
		typ     string
		serve   string
		args    []string
		env     []string
		secrets []string // values that the child's log lines must not show
	}{
		{"http", "http", `{"user": "me", "pass": "hunter2"}`,
			[]string{"--user=me"}, []string{"RCLONE_PASS=hunter2"}, []string{"hunter2"}},
		// rclone prints each item of a list, as well as the whole variable.
		{"s3", "s3", `{"auth_key": ["ak1,sk1", "ak2,sk2"]}`,
			nil, []string{`RCLONE_AUTH_KEY="ak1,sk1","ak2,sk2"`}, []string{"ak1,sk1", "ak2,sk2", `"ak1,sk1","ak2,sk2"`}},
		{"ftp", "ftp", `{"passive_port": "30000-30010", "pass": "x y"}`,
			[]string{"--passive-port=30000-30010"}, []string{"RCLONE_PASS=x y"}, []string{"x y"}},
		{"none", "webdav", `{"user": "me"}`, []string{"--user=me"}, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := ServeCommand(ServeArgs{Type: tc.typ, Source: "/srv", Addr: "127.0.0.1:1",
				Options: groups("serve", tc.serve)}, ServeEnv{})
			if err != nil {
				t.Fatal(err)
			}
			want := slices.Concat([]string{"serve", tc.typ, ":local:/srv/", "--addr=127.0.0.1:1"}, tc.args, serveDefaultFlags)
			if !slices.Equal(s.Args, want) || !slices.Equal(s.Env, tc.env) {
				t.Fatalf("args %q env %q, want %q %q", s.Args, s.Env, want, tc.env)
			}
			if !slices.Equal(s.Secrets, tc.secrets) {
				t.Fatalf("secrets %q, want %q", s.Secrets, tc.secrets)
			}
		})
	}
	// rclone parses the record back into the same pairs.
	var keys fs.CommaSepList
	if err := keys.Set(`"ak1,sk1","ak2,sk2"`); err != nil || !slices.Equal(keys, fs.CommaSepList{"ak1,sk1", "ak2,sk2"}) {
		t.Fatalf("read back %q (%v)", keys, err)
	}
}

// TestServeSecretsOutOfTheForm checks that ServeSecrets removes a serve form's credentials,
// however the page wrote their names, and leaves the rest unchanged. WithServeSecrets puts them
// back, and the command line matches the one built from the whole form.
func TestServeSecretsOutOfTheForm(t *testing.T) {
	a := ServeArgs{Type: "s3", Source: "/srv", Addr: "127.0.0.1:1", Options: groups(
		"serve", `{"user": "me", "--auth-key": ["ak1,sk1"], "pass": "  "}`,
		"vfs", `{"vfs_cache_mode": "writes"}`,
	)}
	kept, secrets, err := ServeSecrets(a)
	if err != nil {
		t.Fatal(err)
	}
	text := func(g catalog.Group) string {
		raw, _ := json.Marshal(g)
		return string(raw)
	}
	if s := text(kept.Options.Serve); strings.Contains(s, "ak1") || !strings.Contains(s, `"user":"me"`) || !strings.Contains(s, `"pass":"  "`) {
		t.Fatalf("kept %s", s)
	}
	if text(kept.Options.VFS) != text(a.Options.VFS) || !strings.Contains(text(a.Options.Serve), "ak1") {
		t.Fatalf("kept %s, the form changed to %s", text(kept.Options.Serve), text(a.Options.Serve))
	}
	if string(secrets) != `{"--auth-key":["ak1,sk1"]}` {
		t.Fatalf("secrets %s", secrets)
	}
	back, err := WithServeSecrets(kept, secrets)
	if err != nil {
		t.Fatal(err)
	}
	whole, err := ServeCommand(a, ServeEnv{})
	if err != nil {
		t.Fatal(err)
	}
	again, err := ServeCommand(back, ServeEnv{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(whole.Args, again.Args) || !slices.Equal(whole.Env, again.Env) || len(again.Env) != 1 {
		t.Fatalf("args %q env %q, want %q %q", again.Args, again.Env, whole.Args, whole.Env)
	}

	// Without credentials, the form is returned unchanged.
	plain := ServeArgs{Type: "http", Options: groups("serve", `{"user": "me"}`)}
	if kept, secrets, err := ServeSecrets(plain); err != nil || secrets != nil || text(kept.Options.Serve) != `{"user":"me"}` {
		t.Fatalf("kept %s secrets %s (%v)", text(kept.Options.Serve), secrets, err)
	}
	if back, err := WithServeSecrets(ServeArgs{Type: "http"}, json.RawMessage(`{"pass":"x"}`)); err != nil || text(back.Options.Serve) != `{"pass":"x"}` {
		t.Fatalf("back %s (%v)", text(back.Options.Serve), err)
	}
}
