package children

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRcloneArgs(t *testing.T) {
	run := filepath.Join(string(filepath.Separator)+"run", "rcui-1")
	full := Limits{LogLevel: "INFO", BwLimit: "10Mi", TPSLimit: 2.5, TPSLimitBurst: 3, UserAgent: "rclone-ui/1 rclone/v1"}
	for _, tc := range []struct {
		name   string
		own    []string
		limits Limits
		want   []string
		absent []string
	}{
		{
			name:   "Serve",
			own:    []string{"serve", "http", "photos:", "--addr=127.0.0.1:8080"},
			limits: full,
			want: []string{"serve", "http", "photos:", "--addr=127.0.0.1:8080",
				"--config=/data/remotes.virtual", "--ask-password=false", "--use-json-log",
				"--log-level=INFO", "--bwlimit=10Mi", "--tpslimit=2.5", "--tpslimit-burst=3",
				"--user-agent=rclone-ui/1 rclone/v1", "--cache-dir=/data/cache", "--stats=0",
				"--rc", "--rc-addr=unix://" + filepath.Join(run, "c-0123abcd.sock")},
		},
		{
			// The tunnel serves its own rc and rejects --rc. Its socket is one more address.
			name:   "Tunnel",
			own:    []string{"tunnel"},
			absent: []string{"--rc"},
		},
		{
			name:   "MountKeepsItsCacheDir",
			own:    []string{"mount", "a:", "/mnt/a", "--cache-dir=/data/cache/vfs/0011"},
			limits: Limits{LogLevel: "NOTICE"},
			absent: []string{"--cache-dir=/data/cache", "--bwlimit", "--tpslimit", "--tpslimit-burst", "--user-agent"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := rcloneArgs(tc.own, run, "0123abcd", "/data/remotes.virtual", "/data/cache", tc.limits)
			if tc.want != nil && !slices.Equal(got, tc.want) {
				t.Fatalf("args\n got %q\nwant %q", got, tc.want)
			}
			for _, a := range got {
				for _, bad := range tc.absent {
					if a == bad || strings.HasPrefix(a, bad+"=") {
						t.Errorf("unexpected %q in %q", a, got)
					}
				}
			}
		})
	}
}

func TestOwnCacheDir(t *testing.T) {
	for _, tc := range []struct {
		own  []string
		want string
	}{
		{[]string{"mount", "a:", "/mnt/a", "--cache-dir=/data/cache/vfs/0011"}, "/data/cache/vfs/0011"},
		{[]string{"serve", "http", "a:", "--cache-dir", "/data/cache/serves/0011"}, "/data/cache/serves/0011"},
		{[]string{"serve", "http", "a:"}, ""},
		{[]string{"serve", "http", "a:", "--cache-dir"}, ""},
	} {
		if got := ownCacheDir(tc.own); got != tc.want {
			t.Errorf("ownCacheDir(%q) = %q, want %q", tc.own, got, tc.want)
		}
	}
}

func TestRcloneEnv(t *testing.T) {
	base := []string{
		"PATH=/bin", "HOME=/home/u", "HTTPS_PROXY=http://proxy:3128", "RCLONE_TRANSFERS=8",
		"RCUI_TOKEN=owner-secret", "RCUI_DEV_EVAL=/data",
		"RCLONE_RC_NO_AUTH=true", "RCLONE_RC_ADDR=:5572",
		"RCLONE_CONFIG=/etc/rclone.conf", "RCLONE_CONFIG_PASS=x", "RCLONE_PASSWORD_COMMAND=pass rclone",
		"RCLONE_LOG_FILE=/var/log/rclone.log", "RCLONE_SYSLOG=true",
	}
	got := rcloneEnv(base, "RCLONE_RC_USER=u", "_RCLONE_CONFIG_KEY_FILE=/run/key-1")
	want := []string{"PATH=/bin", "HOME=/home/u", "HTTPS_PROXY=http://proxy:3128", "RCLONE_TRANSFERS=8",
		"RCLONE_RC_USER=u", "_RCLONE_CONFIG_KEY_FILE=/run/key-1"}
	if !slices.Equal(got, want) {
		t.Fatalf("env\n got %q\nwant %q", got, want)
	}
}

func TestParseMountinfo(t *testing.T) {
	const info = `22 28 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw
28 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw
512 28 0:55 / /home/u/My\040Drive rw,nosuid,nodev,relatime shared:300 - fuse.rclone gdrive: rw,user_id=1000,group_id=1000
513 28 0:56 / /mnt/back\134slash rw shared:301 - fuse.rclone b: rw
bad line
`
	got, err := parseMountinfo(strings.NewReader(info))
	if err != nil {
		t.Fatal(err)
	}
	want := []mountEntry{
		{"/proc", "proc"}, {"/", "ext4"}, {"/home/u/My Drive", "fuse.rclone"}, {`/mnt/back\slash`, "fuse.rclone"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestUnmountCommands(t *testing.T) {
	for goos, want := range map[string][][]string{
		"linux":   {{"fusermount3", "-uz", "/m"}, {"fusermount", "-uz", "/m"}, {"umount", "-l", "/m"}},
		"darwin":  {{"umount", "-f", "/m"}, {"diskutil", "unmount", "force", "/m"}},
		"windows": nil,
	} {
		got := unmountCommands(goos, "/m")
		if !slices.EqualFunc(got, want, slices.Equal) {
			t.Errorf("%s: %q, want %q", goos, got, want)
		}
	}
}
