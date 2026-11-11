package mounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

// writeBack keeps what the fake mount writes in the queue for an hour, so the upload stays
// waiting.
var writeBack = groupsOf("vfs", `{"vfs_cache_mode":"writes","vfs_write_back":"1h"}`)

func TestSupport(t *testing.T) {
	has := func(paths ...string) func(string) bool {
		return func(p string) bool {
			return slices.Contains(paths, p)
		}
	}
	for _, c := range []struct {
		name   string
		goos   string
		exists func(string) bool
		winFsp bool
		ok     bool
	}{
		{"linux with /dev/fuse", "linux", has("/dev/fuse"), false, true},
		{"linux without", "linux", has(), false, false},
		{"windows with WinFsp", "windows", has(), true, true},
		{"windows without", "windows", has("/dev/fuse"), false, false},
		{"macOS mounts over NFS", "darwin", has(), false, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := supportOn(c.goos, c.exists, func() bool { return c.winFsp })
			if got.Supported != c.ok || (got.Reason == "") != c.ok || (got.Docs == "") != c.ok {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// CanInstall is set on Windows when WinFsp is missing and its installer is next to the app.
func TestSupportCanInstall(t *testing.T) {
	dir := t.TempDir()
	missing := func() Support { return Support{Reason: "WinFsp is not installed."} }
	installed := func() Support { return Support{Supported: true} }
	service := func(goos string, support func() Support) *Service {
		return &Service{o: Options{goos: goos, Executable: filepath.Join(dir, "rcui.exe"), support: support}}
	}
	if service("windows", missing).Support().CanInstall {
		t.Fatal("CanInstall without the installer")
	}
	if err := os.WriteFile(filepath.Join(dir, WinFspInstaller), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !service("windows", missing).Support().CanInstall {
		t.Fatal("no CanInstall with the installer")
	}
	if service("windows", installed).Support().CanInstall {
		t.Fatal("CanInstall with WinFsp installed")
	}
	if service("linux", missing).Support().CanInstall {
		t.Fatal("CanInstall on Linux")
	}
}

func TestPrepareMountPoint(t *testing.T) {
	for _, windows := range []bool{false, true} {
		name := "unix"
		if windows {
			name = "windows"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "file")
			full := filepath.Join(dir, "full")
			empty := filepath.Join(dir, "empty")
			missing := filepath.Join(dir, "missing", "deeper")
			for _, p := range []string{full, empty} {
				if err := os.Mkdir(p, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			for _, p := range []string{file, filepath.Join(full, "x")} {
				if err := os.WriteFile(p, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := prepareMountPoint(file, windows); !errors.Is(err, errNotADirectory) {
				t.Errorf("a file: %v", err)
			}
			if err := prepareMountPoint(full, windows); !errors.Is(err, errNotEmpty) {
				t.Errorf("a folder with something in it: %v", err)
			}
			if err := prepareMountPoint(empty, windows); err != nil {
				t.Errorf("an empty folder: %v", err)
			}
			if exists(empty) == windows {
				t.Errorf("an empty folder is kept, except on Windows (exists: %v)", exists(empty))
			}
			if err := prepareMountPoint(missing, windows); err != nil {
				t.Errorf("a missing folder: %v", err)
			}
			if exists(missing) == windows {
				t.Errorf("a missing folder is made, except on Windows (exists: %v)", exists(missing))
			}
			if !windows {
				if err := prepareMountPoint(filepath.Join(file, "under"), windows); !errors.Is(err, errMkdir) {
					t.Errorf("under a file: %v", err)
				}
			}
			// A link is refused, whether it leads to a folder or nowhere, and is left as it is.
			if runtime.GOOS != "windows" { // a symlink needs a privilege on Windows
				target := filepath.Join(dir, "target")
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
				for _, to := range []string{target, filepath.Join(dir, "nowhere")} {
					link := filepath.Join(dir, "link-"+filepath.Base(to))
					if err := os.Symlink(to, link); err != nil {
						t.Fatal(err)
					}
					if err := prepareMountPoint(link, windows); !errors.Is(err, errLink) {
						t.Errorf("a link to %s: %v", to, err)
					}
					if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
						t.Errorf("the link to %s was changed: %v", to, err)
					}
				}
				if exists(filepath.Join(dir, "nowhere")) {
					t.Error("the missing folder that a link leads to was made")
				}
			}
		})
	}

	t.Run("windows folder that cannot be removed", func(t *testing.T) {
		if runtime.GOOS == "windows" || os.Geteuid() == 0 {
			t.Skip("a folder in a 0500 parent can be removed on Windows and by root")
		}
		f := newFixture(t, fixtureOpts{tweak: func(o *Options) { o.goos = "windows" }})
		src, _ := f.place("kept")
		parent := filepath.Join(t.TempDir(), "locked")
		kept := filepath.Join(parent, "mnt")
		if err := os.MkdirAll(kept, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(parent, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })
		if err := prepareMountPoint(kept, true); !errors.Is(err, errNotRemoved) {
			t.Fatalf("got %v, want errNotRemoved", err)
		}
		if !exists(kept) {
			t.Fatal("the folder is gone")
		}
		if _, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: kept}); !errors.Is(err, errNotRemoved) {
			t.Fatalf("start: %v, want errNotRemoved", err)
		}
		time.Sleep(200 * time.Millisecond) // the bus delivers events on its own goroutine
		f.ev.mu.Lock()
		published := slices.Clone(f.ev.list)
		f.ev.mu.Unlock()
		if len(published) != 0 || len(f.s.List()) != 0 {
			t.Fatalf("published %+v, list %+v", published, f.s.List())
		}
	})
}

// TestReadiness checks readiness based on the mount table. A listed mount point is running, a
// child that exits before being listed has failed, and one that isn't listed within the time
// limit has failed and is stopped.
func TestReadiness(t *testing.T) {
	t.Run("ListedMountPoint", func(t *testing.T) {
		f := newFixture(t)
		src, mp := f.place("ok")
		m, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: mp})
		if err != nil {
			t.Fatal(err)
		}
		if m.State != children.StatusStarting || m.MountPoint != mp || m.Source != src || len(m.ID) != 8 {
			t.Fatalf("answered %+v", m)
		}
		if got := f.ev.wait(t, m.ID, children.StatusStarting); got.MountPoint != mp {
			t.Fatalf("starting event %+v", got)
		}
		if got := f.ev.wait(t, m.ID, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
			t.Fatalf("got %+v\n%s", got, f.lines.dump())
		}
		list := f.s.List()
		if len(list) != 1 || list[0].State != children.StatusRunning || list[0].PID == 0 {
			t.Fatalf("list %+v", list)
		}
		// The app makes a missing mount point, except on Windows, where WinFsp makes it and
		// refuses a path that exists. The fake mount makes nothing.
		if made := exists(mp); made == (runtime.GOOS == "windows") {
			t.Fatalf("the missing mount point: made %v", made)
		}
		if len(f.notes.get()) != 0 {
			t.Fatalf("notified %+v", f.notes.get())
		}

		// A change to a remote it mounts flags it until it starts again.
		f.s.RemotesChanged(func(source string) bool { return source == src })
		if l := f.s.List(); len(l) != 1 || !l[0].Restart || !Row(l[0]).Restart {
			t.Fatalf("after the change: %+v", l)
		}
	})

	t.Run("ChildExitsFirst", func(t *testing.T) {
		f := newFixture(t)
		f.fake("--fake-fail=the remote said no")
		src, mp := f.place("exits")
		m, got := f.start(operations.MountArgs{Source: src, Destination: mp})
		if got.State != string(children.StatusFailed) || !strings.Contains(got.Error, "the remote said no") {
			t.Fatalf("got %+v", got)
		}
		if len(f.s.List()) != 0 {
			t.Fatalf("still listed: %+v", f.s.List())
		}
		n := f.notes.get()
		if len(n) != 1 || n[0].event != notifications.NotificationEventMountFailed {
			t.Fatalf("notified %+v", n)
		}
		if p := n[0].payload.(notifications.MountFailed); p.Source != src || p.Destination != mp || !strings.Contains(p.Error, "the remote said no") {
			t.Fatalf("payload %+v", p)
		}
		if got.CannotMount {
			t.Fatal("a computer that can mount said it cannot")
		}
		_ = m
	})

	// A mount that fails after it started, on a computer that can no longer mount, says so in
	// its failed event, so the page can explain how to set mounting up.
	t.Run("FailsWhereItCannotMount", func(t *testing.T) {
		var checks atomic.Int32
		f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
			o.support = func() Support {
				if checks.Add(1) == 1 { // the start's own check
					return Support{Supported: true}
				}
				return Support{Reason: "There is no /dev/fuse."}
			}
		}})
		f.fake("--fake-fail=fusermount3: not found")
		src, mp := f.place("cannot")
		_, got := f.start(operations.MountArgs{Source: src, Destination: mp})
		if got.State != string(children.StatusFailed) || !got.CannotMount {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("NotListedInTime", func(t *testing.T) {
		f := newFixture(t, fixtureOpts{tweak: func(o *Options) { o.readyTimeout = time.Second }})
		f.fake("--fake-never")
		src, mp := f.place("never")
		began := time.Now()
		m, got := f.start(operations.MountArgs{Source: src, Destination: mp})
		if got.State != string(children.StatusFailed) || !strings.Contains(got.Error, "not mounted within 1s") {
			t.Fatalf("got %+v", got)
		}
		if d := time.Since(began); d < time.Second || d > 20*time.Second {
			t.Fatalf("failed after %v", d)
		}
		if len(f.notes.get()) != 1 {
			t.Fatalf("notified %+v", f.notes.get())
		}
		testutil.Eventually(t, 20*time.Second, "the child to be stopped", func() bool { return len(f.sup.Pending()) == 0 && len(f.s.List()) == 0 })
		_ = m
	})
}

func TestStartRefusals(t *testing.T) {
	f := newFixture(t)
	src, mp := f.place("refused")
	if err := os.MkdirAll(mp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mp, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: mp}); !errors.Is(err, errNotEmpty) {
		t.Fatalf("a folder with something in it: %v", err)
	}
	// A refused mount point counts as the mount failing, and sends a notification.
	if n := f.notes.get(); len(n) != 1 || n[0].event != notifications.NotificationEventMountFailed ||
		n[0].payload != (notifications.MountFailed{Source: src, Destination: mp, Error: errNotEmpty.Error()}) {
		t.Fatalf("notified %+v", n)
	}
	f2 := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.support = func() Support { return Support{Reason: "There is no /dev/fuse."} }
	}})
	if _, err := f2.s.Start(f2.ctx, operations.MountArgs{Source: src, Destination: mp}); errs.Of(err) == nil || errs.Of(err).Code != errs.CodeUnsupported || !strings.Contains(err.Error(), "There is no /dev/fuse.") {
		t.Fatalf("a machine that cannot mount: %v", err)
	}

	// With two mounts at the same place, the second is refused while the first is starting.
	_, other := f.place("twice")
	m, _ := f.start(operations.MountArgs{Source: src, Destination: other})
	if _, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: other}); !errs.Is(err) {
		t.Fatalf("the same mount point twice: %v", err)
	}
	if n := f.notes.get(); len(n) != 2 || n[1].payload.(notifications.MountFailed).Destination != other {
		t.Fatalf("notified %+v", n)
	}
	if len(f2.notes.get()) != 0 {
		t.Fatalf("a machine that cannot mount notified %+v", f2.notes.get())
	}
	// A mount point inside another mount would be created through that mount, on its remote.
	// A mount point that contains another mount would hide it.
	for _, dest := range []string{filepath.Join(other, "nested"), filepath.Dir(other)} {
		if _, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: dest}); !errs.Is(err) ||
			!strings.Contains(err.Error(), "is inside") {
			t.Fatalf("a mount point nested with %s, at %s: %v", other, dest, err)
		}
	}
	if _, err := os.Stat(filepath.Join(other, "nested")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the nested mount point was made: %v", err)
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Stop(f.ctx, m.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second stop: %v", err)
	}
}

// TestInside checks that a path below a folder is inside it, while the folder itself and a
// sibling whose name only starts the same way are not. Case is ignored where the OS ignores it.
func TestInside(t *testing.T) {
	for _, tc := range []struct {
		a, b, goos string
		want       bool
	}{
		{"/mnt/a/b", "/mnt/a", "linux", true},
		{"/mnt/a/b/c/", "/mnt/a/", "linux", true},
		{"/mnt/a", "/mnt/a", "linux", false},
		{"/mnt/ab", "/mnt/a", "linux", false},
		{"/mnt", "/mnt/a", "linux", false},
		{"/mnt/A/b", "/mnt/a", "linux", false},
		{"/Volumes/A/b", "/Volumes/a", "darwin", true},
		{"/mnt/../etc/x", "/etc", "linux", true},
		{"/mnt", "/", "linux", true},
		{"/", "/", "linux", false},
	} {
		if got := inside(tc.a, tc.b, tc.goos); got != tc.want {
			t.Errorf("inside(%q, %q, %s) = %v", tc.a, tc.b, tc.goos, got)
		}
	}
}

// TestStop checks that a stop with nothing queued deletes the cache folder, while a stop with
// queued uploads keeps it and lists it in stopped_mounts. Mount again sends the uploads from
// the same folder and removes the row. Discard deletes both the folder and the row.
func TestStop(t *testing.T) {
	f := newFixture(t)

	src, mp := f.place("empty")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	folder := f.folderOf(t, m.ID)
	if !exists(folder) {
		t.Fatalf("no cache folder %s", folder)
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if f.ev.wait(t, m.ID, children.StatusStopped).MountPoint != mp {
		t.Fatal("stopped event without its mount point")
	}
	if exists(folder) {
		t.Fatal("the cache folder of a mount with nothing queued was kept")
	}
	if exists(markerOf(mp)) && runtime.GOOS != "windows" { // on Windows a stop is a kill, with no unmount
		t.Fatal("still mounted")
	}
	if rows := f.stoppedRows(); len(rows) != 0 {
		t.Fatalf("stopped mounts %+v", rows)
	}

	f.fake("--fake-write=queued.txt")
	src, mp = f.place("queued")
	args := operations.MountArgs{Source: src, Destination: mp, Options: writeBack}
	m, got = f.start(args)
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	folder = f.folderOf(t, m.ID)
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	rows := f.stoppedRows()
	if len(rows) != 1 || rows[0].Folder != filepath.Base(folder) || rows[0].Source != src || rows[0].MountPoint != mp ||
		rows[0].Pending == nil || *rows[0].Pending != 1 || rows[0].Args.Destination != mp {
		t.Fatalf("stopped mounts %+v", rows)
	}
	if n, err := dirtyItems(folder); err != nil || n != 1 {
		t.Fatalf("the kept folder holds %d dirty items (%v)", n, err)
	}
	if line := f.lines.cacheRefused(); line != "" {
		t.Fatalf("a mount's VFS cache was refused: %s", line)
	}

	t.Run("MountAgain", func(t *testing.T) {
		f.fake()
		again, err := f.s.MountAgain(f.ctx, rows[0].Folder)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.ev.wait(t, again.ID, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
			t.Fatalf("got %+v", got)
		}
		if f.folderOf(t, again.ID) != folder {
			t.Fatal("mounted again with another cache folder")
		}
		testutil.Eventually(t, 5*time.Second, "the row to go", func() bool { return len(f.stoppedRows()) == 0 })
		if err := f.s.Stop(f.ctx, again.ID); err != nil {
			t.Fatal(err)
		}
		// The upload is still waiting (write back is 1 h), so the mount is listed again.
		if rows := f.stoppedRows(); len(rows) != 1 || *rows[0].Pending != 1 {
			t.Fatalf("stopped mounts %+v", rows)
		}
	})

	t.Run("Discard", func(t *testing.T) {
		if err := f.s.Discard(f.ctx, "../../etc/pass"); !errors.Is(err, ErrNoStopped) {
			t.Fatalf("a path: %v", err)
		}
		if err := f.s.Discard(f.ctx, "0123456789abcdef"); !errors.Is(err, ErrNoStopped) {
			t.Fatalf("no such row: %v", err)
		}
		if err := f.s.Discard(f.ctx, filepath.Base(folder)); err != nil {
			t.Fatal(err)
		}
		if exists(folder) || len(f.stoppedRows()) != 0 {
			t.Fatal("the folder or the row is still there")
		}
	})
}

// TestPointChanged checks that the listings cache hears of a mount point before the pages do,
// when its mount comes up and when it stops, but not while it is only starting.
func TestPointChanged(t *testing.T) {
	var mu sync.Mutex
	var points []string
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.PointChanged = func(mp string) {
			mu.Lock()
			points = append(points, mp)
			mu.Unlock()
		}
	}})
	src, mp := f.place("changed")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	f.ev.wait(t, m.ID, children.StatusStopped)
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(points, []string{mp, mp}) {
		t.Fatalf("points %q, want the mount point once when it came up and once when it stopped", points)
	}
}

// folderOf returns a running mount's cache folder.
func (f *fixture) folderOf(t *testing.T, id string) string {
	t.Helper()
	c := f.s.reg.Get(id)
	if c == nil {
		t.Fatalf("no mount %s", id)
	}
	if folder := c.Own.folder; !strings.HasPrefix(folder, filepath.Join(f.cache, "vfs")+string(filepath.Separator)) || !validFolder(filepath.Base(folder)) {
		t.Fatalf("cache folder %s", folder)
	}
	return c.Own.folder
}

// TestCrash checks that a crashed mount has its mount point cleaned and is started again.
// mount.failed is sent once for the streak, however often the mount crashes.
func TestCrash(t *testing.T) {
	f := newFixture(t)
	f.fake("--fake-crash-after=300ms")
	src, mp := f.place("crash")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	c := f.ev.waitN(t, m.ID, 3, children.StatusRestarting)
	if !strings.Contains(c.Error, "fake mount: crashed") {
		t.Fatalf("restarting event %+v", c)
	}
	f.ev.waitN(t, m.ID, 3, children.StatusRunning)
	if n := f.notes.get(); len(n) != 1 || n[0].event != notifications.NotificationEventMountFailed {
		t.Fatalf("notified %d times: %+v", len(n), n)
	}
	if f.unmounted.Load() < 3 && runtime.GOOS != "windows" { // WinFsp removes a mount when its process ends
		t.Fatalf("the mount point was cleaned %d times", f.unmounted.Load())
	}
	if list := f.s.List(); len(list) != 1 || list[0].ID != m.ID {
		t.Fatalf("list %+v", list)
	}
	f.fake()
	if err := f.s.Stop(context.Background(), m.ID); err != nil {
		t.Fatal(err)
	}
	if len(f.s.List()) != 0 {
		t.Fatal("still listed after its stop")
	}
}

// TestUploadsAndBusy checks that the Mount page's list reads each mount's upload queue when asked,
// and the plain list doesn't. The busy check reads each mount's queue and reports which mounts
// come back.
func TestUploadsAndBusy(t *testing.T) {
	f := newFixture(t)
	f.fake("--fake-write=queued.txt")
	src, mp := f.place("busy")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	f.fake()
	src2, mp2 := f.place("idle")
	if _, got := f.start(operations.MountArgs{Source: src2, Destination: mp2}); got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v", got)
	}

	uploads := map[string]int{}
	for _, x := range f.s.ListUploads(context.Background()) {
		uploads[x.MountPoint] = x.UploadsPending
	}
	if len(uploads) != 2 || uploads[mp] != 1 || uploads[mp2] != 0 {
		t.Fatalf("uploads %v", uploads)
	}
	for _, x := range f.s.List() {
		if x.UploadsPending != 0 {
			t.Fatalf("the plain list read a queue: %+v", x)
		}
	}

	busy := f.s.Busy(context.Background(), false)
	if len(busy) != 2 || busy[0] != (BusyMount{ID: m.ID, Source: src, MountPoint: mp, UploadsPending: 1}) ||
		busy[1].MountPoint != mp2 || busy[1].UploadsPending != 0 || busy[1].Back {
		t.Fatalf("busy %+v", busy)
	}
	for _, b := range f.s.Busy(context.Background(), true) {
		if !b.Back {
			t.Fatalf("after an update's restart every mount comes back: %+v", b)
		}
	}

	// A shutdown where the mounts don't come back lists the uploads left in their caches once
	// every child has stopped.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := f.sup.StopAll(ctx, nil); err != nil {
		t.Fatal(err)
	}
	f.s.Shutdown(context.Background(), true)
	if len(f.stoppedRows()) != 0 {
		t.Fatal("recorded although the mounts come back")
	}
	f.s.Shutdown(context.Background(), false)
	if rows := f.stoppedRows(); len(rows) != 1 || rows[0].MountPoint != mp || *rows[0].Pending != 1 {
		t.Fatalf("stopped mounts %+v", rows)
	}
}

// TestStopWithAFileOpen covers a file that is still open for writing when a user stops the
// mount. The file is dirty in the cache but not in the upload queue. The folder is still kept and
// listed, because pending uploads are never deleted automatically. The same happens at a
// shutdown.
func TestStopWithAFileOpen(t *testing.T) {
	f := newFixture(t)
	f.fake("--fake-open=open.txt")
	src, mp := f.place("open")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	folder := f.folderOf(t, m.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if q, err := f.s.RC(m.ID).VFSQueue(ctx); err != nil || len(q) != 0 {
		t.Fatalf("vfs/queue = %v (%v), want the open file out of it", q, err)
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if !exists(folder) {
		t.Fatal("the cache folder holding a file still being written was deleted")
	}
	if rows := f.stoppedRows(); len(rows) != 1 || rows[0].Folder != filepath.Base(folder) || *rows[0].Pending != 1 {
		t.Fatalf("stopped mounts %+v", rows)
	}

	// The same happens at a shutdown, where reading the queue before the children stop would
	// miss the file.
	f.exec(`DELETE FROM stopped_mounts`)
	src, mp = f.place("open-shutdown")
	m, got = f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	if err := f.sup.StopAll(ctx, nil); err != nil {
		t.Fatal(err)
	}
	f.s.Shutdown(ctx, false)
	if rows := f.stoppedRows(); len(rows) != 1 || rows[0].Folder != filepath.Base(f.folderOf(t, m.ID)) || *rows[0].Pending != 1 {
		t.Fatalf("stopped mounts %+v", rows)
	}
}

// TestSlowStop checks that a stop that takes longer than its wait returns the error, and still
// ends the mount once its child has exited. The mount leaves the list, a stopped event is sent,
// and its mount point is free again. A restart that begins in the meantime doesn't bring it back.
func TestSlowStop(t *testing.T) {
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) { o.stopWait = time.Nanosecond }})
	src, mp := f.place("slow")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	if err := f.s.Stop(f.ctx, m.ID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stop: %v, want its wait exceeded", err)
	}
	if got := f.ev.wait(t, m.ID, children.StatusStopped); got.MountPoint != mp {
		t.Fatalf("stopped event %+v", got)
	}
	testutil.Eventually(t, 10*time.Second, "the mount out of the list", func() bool { return len(f.s.List()) == 0 })
	if err := f.s.Stop(f.ctx, m.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second stop: %v", err)
	}
	again, got := f.start(operations.MountArgs{Source: src, Destination: mp})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("mounting at the same place again: %+v\n%s", got, f.lines.dump())
	}

	// A planned restart during the stop.
	if err := f.s.Stop(f.ctx, again.ID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stop: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := f.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
		t.Fatal(err)
	}
	f.ev.wait(t, again.ID, children.StatusStopped)
	if lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: f.run}); len(lo.Restore) != 0 {
		t.Fatalf("children.json restores %+v, want nothing a user stopped", lo.Restore)
	}
}

// TestShutdownWaitsForAStop checks that a stop keeps going to its cleanup even when the shutdown
// ended its request. The shutdown waits for it before the database closes, so the uploads that
// the mount hadn't sent are recorded.
func TestShutdownWaitsForAStop(t *testing.T) {
	var slow atomic.Bool
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		mounted := o.mounted
		o.mounted = func(mp string) (bool, error) {
			if slow.Load() { // the stop's cleanup takes a while
				time.Sleep(500 * time.Millisecond)
			}
			return mounted(mp)
		}
	}})
	f.fake("--fake-write=queued.txt")
	src, mp := f.place("quit")
	m, got := f.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
	if got.State != string(children.StatusRunning) {
		t.Fatalf("got %+v\n%s", got, f.lines.dump())
	}
	slow.Store(true)
	request, end := context.WithCancel(context.Background())
	end()
	if err := f.s.Stop(request, m.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("stop: %v, want its request's end", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := f.sup.StopAll(ctx, nil); err != nil {
		t.Fatal(err)
	}
	f.s.Shutdown(ctx, false)
	if rows := f.stoppedRows(); len(rows) != 1 || rows[0].MountPoint != mp || rows[0].Pending == nil || *rows[0].Pending != 1 {
		t.Fatalf("stopped mounts %+v, want the stopped mount's upload recorded before the shutdown went on", rows)
	}
}

// TestShutdownClearsMountPoints checks that the shutdown clears what a child left mounted when it
// stopped, whether or not the mounts come back. This happens when the OS refused an unmount, or a
// child was killed after its grace period. An update's restart still brings the mount back.
func TestShutdownClearsMountPoints(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("WinFsp removes a mount with its process")
	}
	for _, restore := range []bool{false, true} {
		t.Run(fmt.Sprintf("restore=%v", restore), func(t *testing.T) {
			f := newFixture(t)
			f.fake("--fake-stay")
			src, mp := f.place("stays")
			m, got := f.start(operations.MountArgs{Source: src, Destination: mp})
			if got.State != string(children.StatusRunning) {
				t.Fatalf("got %+v\n%s", got, f.lines.dump())
			}
			var keep func(children.Record) bool
			if restore {
				keep = func(children.Record) bool { return true }
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := f.sup.StopAll(ctx, keep); err != nil {
				t.Fatal(err)
			}
			if !exists(markerOf(mp)) {
				t.Fatal("the child unmounted itself; the test needs it left mounted")
			}
			before := f.unmounted.Load()
			f.s.Shutdown(ctx, restore)
			if exists(markerOf(mp)) || f.unmounted.Load() != before+1 {
				t.Fatalf("still mounted after the shutdown (unmounted %d times)", f.unmounted.Load()-before)
			}
			lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: f.run})
			if restore && (len(lo.Restore) != 1 || lo.Restore[0].ID != m.ID) {
				t.Fatalf("children.json restores %+v, want the mount back after the restart", lo.Restore)
			}
		})
	}
}

// TestWindowsDrive checks that the app picks the drive for a Windows `*` mount when it starts.
// It counts down from Z:, skipping drives in use and the drives of this app's mounts that are
// still starting. That way readiness doesn't depend on cmount's NOTICE line, which a quieter
// --log-level leaves out. The child is started on that drive.
func TestWindowsDrive(t *testing.T) {
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.goos = "windows"
		o.drives = func() uint32 { return 1<<('Z'-'A') | 1<<('Y'-'A') }
	}})
	f.fake("--fake-never")
	src, _ := f.place("drive")
	m, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: "*"})
	if err != nil {
		t.Fatal(err)
	}
	if m.MountPoint != "X:" {
		t.Fatalf("answered %+v, want the mount on X:", m)
	}
	if got := f.ev.wait(t, m.ID, children.StatusStarting); got.MountPoint != "X:" {
		t.Fatalf("starting event %+v", got)
	}
	var (
		b   []byte
		doc struct{ Children []children.Record }
	)
	testutil.Eventually(t, 20*time.Second, "the child in children.json", func() bool {
		b, _ = os.ReadFile(filepath.Join(f.run, "children.json"))
		return json.Unmarshal(b, &doc) == nil && len(doc.Children) > 0
	})
	if len(doc.Children) != 1 || doc.Children[0].MountPoint != "X:" || len(doc.Children[0].Args) < 3 || doc.Children[0].Args[2] != "X:" {
		t.Fatalf("children.json %s", b)
	}
	next := &child{Own: mount{mountPoint: "*"}}
	if err := f.s.reserve(next, ""); err != nil || next.Own.mountPoint != "W:" {
		t.Fatalf("the next `*` got %q (%v), want W:", next.Own.mountPoint, err)
	}
	f.s.reg.Drop(next)
	// A second `*` mount of the same source would share the first one's cache folder.
	if _, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: "*"}); !errs.Is(err) ||
		!strings.Contains(err.Error(), "is already mounted on a drive Rclone UI picked") {
		t.Fatalf("a second `*` mount of one source: %v", err)
	}
	if err := f.s.Stop(f.ctx, m.ID); err != nil {
		t.Fatal(err)
	}

	full := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.goos = "windows"
		o.drives = func() uint32 { return 1<<26 - 1 }
	}})
	if _, err := full.s.Start(full.ctx, operations.MountArgs{Source: src, Destination: "*"}); !errs.Is(err) {
		t.Fatalf("every drive in use: %v", err)
	}
}

// TestFlatpakCannotMount checks that mounting is never supported inside the Flatpak, whatever
// devices it can see.
func TestFlatpakCannotMount(t *testing.T) {
	t.Setenv("FLATPAK_ID", "org.rclone.ui")
	if s := CheckSupport(); s.Supported || !strings.Contains(s.Reason, "Flatpak") {
		t.Fatalf("got %+v", s)
	}
}

// TestKeepWaiting checks that a stopped mount is recorded with the larger of its queue and its
// dirty items, when that number is above zero. For a folder that can't be read, only the queue
// is counted, and the count is reported as unknown when the queue was empty.
func TestKeepWaiting(t *testing.T) {
	f := newFixture(t)
	for i, tc := range []struct {
		name       string
		dirty      int
		unreadable bool
		queued     int
		n          int
		known      bool
	}{
		{name: "nothing, the queue unread", queued: -1, n: 0, known: true},
		{name: "more dirty than queued", dirty: 2, queued: 1, n: 2, known: true},
		{name: "unreadable, the queue read", unreadable: true, queued: 3, n: 3, known: true},
		{name: "unreadable, nothing queued", unreadable: true, queued: 0, n: 0, known: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.unreadable && (runtime.GOOS == "windows" || os.Geteuid() == 0) {
				t.Skip("an unreadable folder needs Unix permissions and a user who isn't root")
			}
			f.exec(`DELETE FROM stopped_mounts`)
			folder := filepath.Join(f.cache, "vfs", fmt.Sprintf("%016x", i))
			meta := filepath.Join(folder, "vfsMeta", "remote")
			if err := os.MkdirAll(meta, 0o700); err != nil {
				t.Fatal(err)
			}
			for j := range tc.dirty {
				if err := os.WriteFile(filepath.Join(meta, fmt.Sprint(j)), []byte(`{"Dirty":true}`), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(meta, "clean"), []byte(`{"Dirty":false}`), 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.unreadable {
				vfsMeta := filepath.Join(folder, "vfsMeta")
				if err := os.Chmod(vfsMeta, 0); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(vfsMeta, 0o700) })
			}
			w := waiting{folder: folder, args: operations.MountArgs{Source: "gdrive:", Destination: "/mnt/g"}, mountPoint: "/mnt/g"}
			n, known := f.s.keepWaiting(f.ctx, f.s.log, w, tc.queued)
			if n != tc.n || known != tc.known {
				t.Fatalf("got %d (known %v), want %d (known %v)", n, known, tc.n, tc.known)
			}
			rows := f.stoppedRows()
			if tc.n == 0 {
				if len(rows) != 0 {
					t.Fatalf("recorded %+v", rows)
				}
				return
			}
			if len(rows) != 1 || rows[0].Folder != filepath.Base(folder) ||
				rows[0].MountPoint != "/mnt/g" || rows[0].Pending == nil || *rows[0].Pending != int64(tc.n) {
				t.Fatalf("stopped mounts %+v", rows)
			}
		})
	}
}

// TestSupportLocalized checks that the reason why this computer can't mount reaches the page in
// the app's language, and stays English for the logs.
func TestSupportLocalized(t *testing.T) {
	sup := supportOn("windows", func(string) bool { return false }, func() bool { return false })
	if sup.Reason != "WinFsp is not installed." || sup.localized().Reason != sup.Reason {
		t.Fatalf("got %+v", sup)
	}
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	if got := sup.localized().Reason; !strings.HasPrefix(got, "[") {
		t.Errorf("in the pseudo-language: %q", got)
	}
	if sup.Reason != "WinFsp is not installed." {
		t.Errorf("the logs' reason changed: %q", sup.Reason)
	}
	// The reason is translated with the message that holds it.
	if err := unsupported(sup); strings.Count(i18n.Localize(err), "[") != 2 {
		t.Errorf("the refusal: %q", i18n.Localize(err))
	}
}
