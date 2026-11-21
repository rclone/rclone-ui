package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	// The mount commands that a mount child of this test binary runs: nfsmount on macOS, and FUSE
	// on Linux. Each builds everywhere, as a stub where it doesn't run.
	_ "github.com/rclone/rclone/cmd/mount"
	_ "github.com/rclone/rclone/cmd/nfsmount"
)

// A remote's folder is mounted, read through the mount point, listed, and unmounted. The
// refusals come first, since they need no mount.
func TestMountTools(t *testing.T) {
	cs := connect(t)
	if _, failed := call[unmounted](t, cs, "unmount", map[string]any{"mount_id": "no-such-mount"}); !strings.Contains(failed, "not running") {
		t.Errorf("unmounting what isn't mounted: %q", failed)
	}
	sup, err := apis.Mounts.Support(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !sup.Supported {
		if _, failed := call[mountItem](t, cs, "mount", map[string]any{"source": "box:" + t.TempDir()}); !strings.Contains(failed, "can't mount") {
			t.Errorf("a mount where the computer can't mount: %q", failed)
		}
		t.Skipf("this computer can't mount: %s", sup.Reason)
	}
	if runtime.GOOS == "windows" {
		t.Skip("a mount on Windows needs cmount, which this test binary doesn't have (-tags cmount)")
	}
	if _, failed := call[mountItem](t, cs, "mount", map[string]any{"source": t.TempDir()}); !strings.Contains(failed, "mount_point") {
		t.Errorf("a local folder without a mount point: %q", failed)
	}

	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("through the mount"), 0o600); err != nil {
		t.Fatal(err)
	}
	// base is not under t.TempDir, whose cleanup would walk into a mount that is still there.
	//
	// The mount point is spelled "Mounts", while the folder on disk is "mounts". The same happens
	// when the suggested ~/Rclone/box meets a folder called ~/rclone: on a Mac both name one
	// folder, and the mount table names it as the disk does. The mount must still count as ready.
	base, err := os.MkdirTemp("", "rcui-mnt-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "mounts"), 0o700); err != nil {
		t.Fatal(err)
	}
	point := filepath.Join(base, "Mounts", "box")
	var id string
	t.Cleanup(func() {
		if id != "" {
			_ = apis.Mounts.Stop(context.Background(), id)
		}
		_ = os.RemoveAll(base)
	})
	m := must[mountItem](t, cs, "mount", map[string]any{
		"source": "box:" + src, "mount_point": point,
		"options": map[string]any{"vfs_cache_mode": "writes", "no_such_option": true},
	})
	id = m.ID
	if m.MountPoint != point || m.State != "running" {
		t.Fatalf("mount: %+v, want it running at %s", m, point)
	}
	if len(m.IgnoredOptions) != 1 || m.IgnoredOptions[0].Option != "no_such_option" || m.IgnoredOptions[0].Reason == "" {
		t.Errorf("ignored options: %+v", m.IgnoredOptions)
	}
	if b, err := os.ReadFile(filepath.Join(point, "a.txt")); err != nil || string(b) != "through the mount" {
		t.Errorf("a file through the mount point: %q, %v", b, err)
	}
	list := must[mountList](t, cs, "list_mounts", nil)
	if len(list.Mounts) != 1 || list.Mounts[0].ID != m.ID || list.Mounts[0].Source != "box:"+src || list.Mounts[0].State != "running" {
		t.Errorf("list_mounts: %+v", list)
	}

	if got := must[unmounted](t, cs, "unmount", map[string]any{"mount_id": m.ID}); got.Unmounted != point {
		t.Errorf("unmount: %+v", got)
	}
	id = ""
	if list := must[mountList](t, cs, "list_mounts", nil); len(list.Mounts) != 0 {
		t.Errorf("list_mounts after unmount: %+v", list)
	}
	if _, err := os.Stat(filepath.Join(point, "a.txt")); err == nil {
		t.Error("the file is still in the mount point after unmount")
	}
}

func TestSuggestedMountPoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		if got, err := suggestedMountPoint(`C:\Users\me`); got != "*" || err != nil {
			t.Errorf("on Windows: %q, %v", got, err)
		}
		return
	}
	for source, want := range map[string]string{
		"box:/a/b":           filepath.Join(home, "Rclone", "box"),
		"gdrive,team=x:Docs": filepath.Join(home, "Rclone", "gdrive"),
		":s3:bucket":         filepath.Join(home, "Rclone", "s3"),
	} {
		if got, err := suggestedMountPoint(source); got != want || err != nil {
			t.Errorf("%s: %q, %v, want %s", source, got, err, want)
		}
	}
	for _, source := range []string{"/Users/me/Photos", ":local:/tmp"} {
		if _, err := suggestedMountPoint(source); err == nil || !strings.Contains(err.Error(), "mount_point") {
			t.Errorf("%s: %v", source, err)
		}
	}
	if _, err := suggestedMountPoint("relative/path"); err == nil {
		t.Error("a path that isn't full has a suggestion")
	}
}

// A folder is served over http on a free port of this computer, a file is fetched from it, and
// the serve is stopped. A serve without a sign-in warns, and one with a user and password asks
// for them.
func TestServeTools(t *testing.T) {
	cs := connect(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("served"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, failed := call[serveItem](t, cs, "serve", map[string]any{"source": dir, "protocol": "gopher"}); !strings.Contains(failed, "http") {
		t.Errorf("an unknown protocol: %q", failed)
	}
	if _, failed := call[stopped](t, cs, "stop_serve", map[string]any{"serve_id": "no-such-serve"}); !strings.Contains(failed, "not running") {
		t.Errorf("stopping what isn't served: %q", failed)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	v := must[serveItem](t, cs, "serve", map[string]any{
		"source": dir, "protocol": "HTTP", "address": addr, "options": map[string]any{"no_such_option": 1},
	})
	t.Cleanup(func() { _ = apis.Serves.Stop(context.Background(), v.ID) })
	if v.Address != addr || v.State != "running" || v.Protocol != "http" || v.Source != dir {
		t.Fatalf("serve: %+v", v)
	}
	if !strings.Contains(v.Warning, "any program on this computer") {
		t.Errorf("a serve without a sign-in: its warning is %q", v.Warning)
	}
	if len(v.IgnoredOptions) != 1 || v.IgnoredOptions[0].Option != "no_such_option" {
		t.Errorf("ignored options: %+v", v.IgnoredOptions)
	}
	if code, body := fetch(t, "http://"+addr+"/a.txt"); code != http.StatusOK || body != "served" {
		t.Errorf("a.txt over http: %d %q", code, body)
	}

	// With a user and a password, a client must sign in, and there is no warning.
	locked := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	w := must[serveItem](t, cs, "serve", map[string]any{
		"source": dir, "protocol": "http", "address": locked, "options": map[string]any{"user": "me", "pass": "s3cret"},
	})
	t.Cleanup(func() { _ = apis.Serves.Stop(context.Background(), w.ID) })
	if w.Warning != "" {
		t.Errorf("a serve with a sign-in warns: %q", w.Warning)
	}
	if code, _ := fetch(t, "http://"+locked+"/a.txt"); code != http.StatusUnauthorized {
		t.Errorf("without signing in: %d", code)
	}
	if code, body := fetch(t, "http://me:s3cret@"+locked+"/a.txt"); code != http.StatusOK || body != "served" {
		t.Errorf("signed in: %d %q", code, body)
	}

	list := must[serveList](t, cs, "list_serves", nil)
	ids := []string{}
	for _, item := range list.Serves {
		ids = append(ids, item.ID)
	}
	if len(ids) != 2 || !slices.Contains(ids, v.ID) || !slices.Contains(ids, w.ID) {
		t.Errorf("list_serves: %+v", list)
	}
	for _, id := range []string{v.ID, w.ID} {
		must[stopped](t, cs, "stop_serve", map[string]any{"serve_id": id})
	}
	if list := must[serveList](t, cs, "list_serves", nil); len(list.Serves) != 0 {
		t.Errorf("list_serves after stop_serve: %+v", list)
	}
	if _, err := http.Get("http://" + addr + "/a.txt"); err == nil {
		t.Error("the address still answers after stop_serve")
	}
}

func fetch(t *testing.T, url string) (int, string) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestOpenWarning(t *testing.T) {
	for _, c := range []struct {
		protocol, addr, options, want string
	}{
		{"webdav", ":8080", `{}`, "anyone who can reach :8080 can read and change"},
		{"webdav", "[::1]:8080", `{"read_only": true}`, "any program on this computer"},
		{"webdav", "localhost:8080", `{"user": "me", "pass": "x"}`, ""},
		{"s3", "0.0.0.0:8080", `{"auth_key": ["a,b"]}`, ""},
		{"s3", "0.0.0.0:8080", `{}`, "auth_key"},
		{"dlna", ":7879", `{}`, "dlna has no sign-in, so anyone who can reach :7879 can read the files."},
		{"sftp", ":2022", `{}`, ""},
		{"sftp", ":2022", `{"no_auth": true}`, "no_auth is set"},
	} {
		var options map[string]any
		if err := json.Unmarshal([]byte(c.options), &options); err != nil {
			t.Fatal(err)
		}
		groups, _, err := optionGroupsFor("serve", c.protocol, options)
		if err != nil {
			t.Fatal(err)
		}
		got := openWarning(c.protocol, c.addr, groups.Serve)
		if c.want == "" && got != "" || !strings.Contains(got, c.want) {
			t.Errorf("%s at %s with %s: %q, want %q", c.protocol, c.addr, c.options, got, c.want)
		}
	}
}

// open_window opens the window of a route, with what it starts with in its query, as the
// launcher opens it. It refuses a window that doesn't exist, and an argument that the window
// doesn't take.
func TestOpenWindow(t *testing.T) {
	cs := connect(t)
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"window": "history"}, "/history"},
		{map[string]any{"window": "History", "transfer_id": "t-1"}, "/history?id=t-1"},
		{map[string]any{"window": "copy", "source": "box:/a b", "destination": "/c"}, "/copy?initialDestination=%2Fc&initialSource=box%3A%2Fa+b"},
		{map[string]any{"window": "mount", "source": "box:", "destination": "/mnt/box"}, "/mount?initialDestination=%2Fmnt%2Fbox&initialSource=box%3A"},
		{map[string]any{"window": "commander", "source": "box:/x"}, "/commander?path=box%3A%2Fx"},
		{map[string]any{"window": " Settings "}, "/settings"},
		{map[string]any{"window": "mobileRemoteControl"}, "/mobileRemoteControl"},
		{map[string]any{"window": "mobileremotecontrol"}, "/mobileRemoteControl"},
	} {
		opened = nil
		got := must[windowOpened](t, cs, "open_window", c.args)
		if len(opened) != 1 || opened[0] != c.want || got.Opened == "" {
			t.Errorf("%v: opened %v (%+v), want %s", c.args, opened, got, c.want)
		}
	}
	opened = nil
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"window": "launcher"}, "remotes, commander, history"},
		{map[string]any{"window": "copy", "transfer_id": "t-1"}, "transfer_id"},
		{map[string]any{"window": "settings", "source": "box:"}, "no source"},
		{map[string]any{"window": "delete", "destination": "/x"}, "no destination"},
	} {
		if _, failed := call[windowOpened](t, cs, "open_window", c.args); !strings.Contains(failed, c.want) {
			t.Errorf("%v: %q, want it to say %q", c.args, failed, c.want)
		}
	}
	if len(opened) != 0 {
		t.Errorf("a refused call opened %v", opened)
	}
}
