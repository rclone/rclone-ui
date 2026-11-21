package mounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// sourceDouble responds to the service's checks of a mount's source (Options.list, stat).
type sourceDouble struct {
	mu     sync.Mutex
	calls  []string // "list|stat root path"
	answer func(look, root, path string) (found, isDir bool, err error)
}

func (d *sourceDouble) record(look, root, path string) {
	d.mu.Lock()
	d.calls = append(d.calls, look+" "+root+" "+path)
	d.mu.Unlock()
}

func (d *sourceDouble) list(_ context.Context, root, dir string) error {
	d.record("list", root, dir)
	_, _, err := d.answer("list", root, dir)
	return err
}

func (d *sourceDouble) stat(_ context.Context, root, remote string) (bool, bool, error) {
	d.record("stat", root, remote)
	return d.answer("stat", root, remote)
}

func (d *sourceDouble) seam(o *Options) { o.list, o.stat = d.list, d.stat }

func (d *sourceDouble) got() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.calls)
}

func (d *sourceDouble) reset() {
	d.mu.Lock()
	d.calls = nil
	d.mu.Unlock()
}

// store writes an automount straight into the automounts table.
func (f *fixture) store(m Automount) {
	f.t.Helper()
	raw, _ := json.Marshal(m.Options)
	f.exec(`INSERT INTO automounts (id, remote, remote_path, mount_point, options, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 1)`, m.Remote+":"+m.RemotePath+"@"+m.MountPoint, m.Remote, m.RemotePath, m.MountPoint,
		string(raw), m.Enabled)
}

func TestSaveAutomount(t *testing.T) {
	d := &sourceDouble{answer: func(look, root, path string) (bool, bool, error) {
		if look == "list" && strings.HasSuffix(root, ".jpg") {
			return false, false, errors.New("is a file")
		}
		switch path {
		case "photos/2024":
			return true, true, nil
		case "photos/a.jpg":
			return true, false, nil
		case "gone":
			return false, false, nil
		case "offline":
			return false, false, errors.New("dial tcp: no route to host")
		}
		if strings.HasPrefix(root, "down:") {
			return false, false, errors.New("connection refused")
		}
		return true, true, nil
	}}
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		d.seam(o)
		o.RemoteNames = func() []string { return []string{"gdrive", "down"} }
	}})
	_, mp := f.place("auto")
	_, mp2 := f.place("auto2")
	fresh := func(name string) string { return filepath.Join(t.TempDir(), name) }

	for _, c := range []struct {
		name   string
		form   Automount
		field  string // "" with msg means a refusal without a field
		msg    string
		probes []string
	}{
		{name: "no remote", form: Automount{MountPoint: mp}, field: "remote", msg: "Please choose a remote"},
		{name: "an unknown remote", form: Automount{Remote: "nope", MountPoint: mp}, field: "remote", msg: "There is no remote named nope."},
		{name: "no mount point", form: Automount{Remote: "gdrive", Enabled: true, RemotePath: "photos"},
			field: "mountPoint", msg: "Please choose a mount point"},
		{name: "the whole remote", form: Automount{Remote: "gdrive", Enabled: true, MountPoint: mp},
			probes: []string{"list gdrive: "}},
		{name: "a mapper without metadata", form: Automount{Remote: "gdrive", MountPoint: mp,
			Options: groupsOf("metadata", `{"metadata_mapper":["metadata-map","--set","a=b"]}`)},
			field: "options.metadata", msg: `Set "metadata": true to use the metadata mapper`},
		{name: "a path that is not there", form: Automount{Remote: "gdrive", Enabled: true, RemotePath: "gone", MountPoint: fresh("gone")},
			field: "remotePath", msg: `"gone" was not found on gdrive:.`,
			probes: []string{"stat gdrive: gone"}},
		{name: "a file", form: Automount{Remote: "gdrive", Enabled: true, RemotePath: "photos/a.jpg", MountPoint: fresh("file")},
			field: "remotePath", msg: `"photos/a.jpg" on gdrive: is a file, not a folder.`,
			probes: []string{"stat gdrive: photos/a.jpg", "list gdrive:photos/a.jpg "}},
		{name: "a folder", form: Automount{Remote: "gdrive", Enabled: true, RemotePath: "photos/2024/", MountPoint: fresh("folder")},
			probes: []string{"stat gdrive: photos/2024"}},
		{name: "a probe that cannot tell", form: Automount{Remote: "gdrive", Enabled: true, RemotePath: "offline", MountPoint: mp2},
			probes: []string{"stat gdrive: offline"}},
		{name: "a root that does not answer", form: Automount{Remote: "down", Enabled: true, RemotePath: "/", MountPoint: filepath.Join(t.TempDir(), "down")},
			probes: []string{"list down:/ "}},
		{name: "switched off: no probe", form: Automount{Remote: "gdrive", RemotePath: "gone", MountPoint: mp}},
	} {
		t.Run(c.name, func(t *testing.T) {
			d.reset()
			_, err := f.s.SaveAutomount(f.ctx, c.form)
			switch {
			case c.msg == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case c.msg != "" && (!errs.Is(err) || errs.FieldOf(err) != c.field || err.Error() != c.msg):
				t.Fatalf("got %#v, want %s: %s", err, c.field, c.msg)
			}
			if got := d.got(); !slices.Equal(got, c.probes) {
				t.Fatalf("probes %q, want %q", got, c.probes)
			}
		})
	}
	// The saved ones: the whole remote, a folder, a probe that couldn't tell, the root of down, and
	// the one switched off.
	rows, err := f.s.Automounts(f.ctx)
	if err != nil || len(rows) != 5 {
		t.Fatalf("saved %d (%v)", len(rows), err)
	}

	t.Run("OneMountPointPerAutomountThatIsOn", func(t *testing.T) {
		_, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "gdrive", Enabled: true, RemotePath: "photos/2024", MountPoint: mp})
		if errs.FieldOf(err) != "mountPoint" || !strings.Contains(err.Error(), "already uses this mount point") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("RoundTripAndSeveralPerRemote", func(t *testing.T) {
		mp3 := filepath.Join(t.TempDir(), "three")
		a, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "gdrive", Enabled: true, RemotePath: "photos/2024", MountPoint: mp3,
			Options: groupsOf("vfs", `{"vfs_cache_mode":"full"}`, "config", `{}`)})
		if err != nil || a.ID == "" || a.CreatedAt == 0 {
			t.Fatalf("%+v %v", a, err)
		}
		rows, _ := f.s.Automounts(f.ctx)
		i := slices.IndexFunc(rows, func(r AutomountRow) bool { return r.ID == a.ID })
		if i < 0 || rows[i].RemotePath != "photos/2024" || string(rows[i].Options.VFS["vfs_cache_mode"]) != `"full"` || rows[i].MountID != "" || rows[i].RemoteMissing {
			t.Fatalf("read back %+v", rows)
		}
		a.MountPoint, a.Enabled = filepath.Join(t.TempDir(), "four"), false
		if b, err := f.s.SaveAutomount(f.ctx, a); err != nil || b.ID != a.ID || b.CreatedAt != a.CreatedAt {
			t.Fatalf("an edit: %+v %v", b, err)
		}
		points, err := AutomountPoints(context.Background(), f.db, f.s.o.goos)
		if err != nil || slices.Contains(points, a.MountPoint) || !slices.Contains(points, mp) {
			t.Fatalf("automount points %v (%v)", points, err)
		}
		if err := f.s.DeleteAutomount(f.ctx, a.ID); err != nil {
			t.Fatal(err)
		}
		if err := f.s.DeleteAutomount(f.ctx, a.ID); !errors.Is(err, ErrNoAutomount) {
			t.Fatalf("a second delete: %v", err)
		}
		if _, err := f.s.SaveAutomount(f.ctx, a); !errors.Is(err, ErrNoAutomount) {
			t.Fatalf("an edit after the delete: %v", err)
		}
	})

	t.Run("RenameRemote", func(t *testing.T) {
		if err := f.s.RenameRemote(f.ctx, "down", "up"); err != nil {
			t.Fatal(err)
		}
		rows, _ := f.s.Automounts(f.ctx)
		for _, r := range rows {
			if r.Remote == "down" || r.Remote == "up" && !r.RemoteMissing {
				t.Fatalf("after the rename %+v", r)
			}
		}
	})
}

// TestAutomountOfTheWholeRemote checks that an empty remote path mounts the remote's root.
func TestAutomountOfTheWholeRemote(t *testing.T) {
	if a := (Automount{Remote: "gdrive", Enabled: true, MountPoint: "/m"}).args(); a.Source != "gdrive:" || a.Destination != "/m" {
		t.Errorf("args %+v", a)
	}
}

// TestBootAutomounts checks that at start, each enabled automount is probed (with retries),
// started, and then listed once more. A mount whose source doesn't respond is skipped after the
// retries, and one whose path is missing is skipped at once. Both send notifications and show OS
// notifications. Remotes that no longer exist are skipped. A computer that can't mount sends no
// notifications.
func TestBootAutomounts(t *testing.T) {
	var (
		mu       sync.Mutex
		attempts = map[string]int{}
	)
	d := &sourceDouble{answer: func(look, root, path string) (bool, bool, error) {
		mu.Lock()
		attempts[root]++
		n := attempts[root]
		mu.Unlock()
		if path != "photos" {
			return false, false, errors.New("not a look at the mount's path")
		}
		if look == "list" { // the listing after the mount is up
			if strings.Contains(root, "flaky") {
				return false, false, errors.New("connection reset")
			}
			return true, true, nil
		}
		switch {
		case strings.Contains(root, "slow") && n < 3: // responds on the third attempt
			return false, false, errors.New("network is unreachable")
		case strings.Contains(root, "dead"):
			return false, false, errors.New("network is unreachable")
		case strings.Contains(root, "moved"):
			return false, false, nil
		}
		return true, true, nil
	}}
	remotes := []string{"slow", "dead", "moved", "flaky"}
	tweak := func(o *Options) {
		d.seam(o)
		o.RemoteNames = func() []string { return remotes }
		o.probeDelays = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}
	}
	f := newFixture(t, fixtureOpts{tweak: tweak})
	// The remotes are aliases of local folders, in the config file that the children read.
	disk := filepath.Join(f.base, "disk")
	if err := os.MkdirAll(filepath.Join(disk, "photos"), 0o700); err != nil {
		t.Fatal(err)
	}
	var conf strings.Builder
	for _, r := range []string{"slow", "dead", "moved", "flaky", "gone"} {
		fmt.Fprintf(&conf, "[%s]\ntype = alias\nremote = %s\n\n", r, filepath.ToSlash(disk))
	}
	if err := os.WriteFile(f.config, []byte(conf.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	_, mp := f.place("slow")
	_, deadMp := f.place("dead")
	_, movedMp := f.place("moved")
	_, flakyMp := f.place("flaky")
	_, goneMp := f.place("gone")
	f.store(Automount{Remote: "slow", Enabled: true, RemotePath: "photos", MountPoint: mp, Options: writeBack})
	f.store(Automount{Remote: "dead", Enabled: true, RemotePath: "photos", MountPoint: deadMp})
	f.store(Automount{Remote: "moved", Enabled: true, RemotePath: "photos", MountPoint: movedMp})
	f.store(Automount{Remote: "flaky", Enabled: true, RemotePath: "photos", MountPoint: flakyMp, Options: writeBack})
	f.store(Automount{Remote: "gone", Enabled: true, RemotePath: "photos", MountPoint: goneMp})
	f.store(Automount{Remote: "off", RemotePath: "photos", MountPoint: goneMp})

	f.s.Boot(f.ctx)
	all := f.s.List()
	if len(all) != 2 {
		t.Fatalf("list %+v", all)
	}
	var list []Mount
	for _, m := range all {
		if got := f.ev.wait(t, m.ID, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
			t.Fatalf("got %+v\n%s", got, f.lines.dump())
		}
		if m.Source == "slow:photos" {
			list = append(list, m)
		}
	}
	if len(list) != 1 || list[0].MountPoint != mp || !list[0].Automount {
		t.Fatalf("list %+v", all)
	}
	// slow: two failures, the success, and the listing after mounting. dead: every attempt of
	// the backoff. moved: once, because a wrong path isn't retried.
	mu.Lock()
	if want := map[string]int{"slow:": 4, "dead:": len(f.s.o.probeDelays) + 1, "moved:": 1, "flaky:": 2}; !maps.Equal(attempts, want) {
		t.Fatalf("attempts %v, want %v", attempts, want)
	}
	mu.Unlock()
	n := f.notes.get()
	if len(n) != 2 {
		t.Fatalf("notified %+v", n)
	}
	skipped := map[string]notifications.MountFailed{}
	for _, note := range n {
		p := note.payload.(notifications.MountFailed)
		if note.event != notifications.NotificationEventMountFailed || !p.Skipped {
			t.Fatalf("notified %+v", note)
		}
		skipped[p.Source] = p
	}
	if p := skipped["dead:photos"]; p.Destination != deadMp || p.Reason != "" || p.Error != "network is unreachable" {
		t.Fatalf("dead: %+v", p)
	}
	if p := skipped["moved:photos"]; p.Destination != movedMp || !strings.Contains(p.Reason, `"photos" was not found on moved:`) || !strings.HasSuffix(p.Reason, "Fix its folder in the Automounts window.") {
		t.Fatalf("moved: %+v", p)
	}
	// The flaky mount is up, with a warning that its folder may look empty.
	got := f.ev.toastTitles()
	slices.Sort(got)
	if !slices.Equal(got, []string{"Automount may look empty", "Automount skipped", "Automount skipped"}) {
		t.Fatalf("OS notifications %q", got)
	}
	// An automount keeps its cache folder when stopped.
	folder := f.folderOf(t, list[0].ID)
	if err := f.s.Stop(f.ctx, list[0].ID); err != nil {
		t.Fatal(err)
	}
	if !exists(folder) {
		t.Fatal("an automount's cache folder was deleted")
	}

	t.Run("CannotMount", func(t *testing.T) {
		g := newFixture(t, fixtureOpts{db: f.db, data: f.data, tweak: func(o *Options) {
			tweak(o)
			o.support = func() Support { return Support{Reason: "There is no /dev/fuse."} }
		}})
		g.s.Boot(g.ctx)
		if len(g.s.List()) != 0 || len(g.notes.get()) != 0 {
			t.Fatalf("list %+v, notified %+v", g.s.List(), g.notes.get())
		}
	})
}

// TestBootRestore checks that after a planned restart, the mounts that were running start again
// with the same id and cache folder. On a computer that can no longer mount, they don't start,
// and a mount whose cache holds uploads that rclone hadn't sent is listed in stopped_mounts.
func TestBootRestore(t *testing.T) {
	for _, canMount := range []bool{true, false} {
		t.Run(fmt.Sprintf("canMount=%v", canMount), func(t *testing.T) {
			first := newFixture(t)
			first.fake("--fake-write=queued.txt")
			src, mp := first.place("restored")
			m, got := first.start(operations.MountArgs{Source: src, Destination: mp, Options: writeBack})
			if got.State != string(children.StatusRunning) {
				t.Fatalf("got %+v\n%s", got, first.lines.dump())
			}
			folder := first.folderOf(t, m.ID)
			// The planned restart stops every child and keeps the running mounts so they come back.
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := first.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
				t.Fatal(err)
			}
			lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: first.run})
			if len(lo.Restore) != 1 {
				t.Fatalf("restore %+v", lo.Restore)
			}

			next := newFixture(t, fixtureOpts{pending: lo.Restore, run: first.run, data: first.data, db: first.db, tweak: func(o *Options) {
				if !canMount {
					o.support = func() Support { return Support{Reason: "WinFsp is not installed."} }
				}
			}})
			next.s.Boot(next.ctx)
			if len(next.sup.Pending()) != 0 {
				t.Fatalf("still pending %+v", next.sup.Pending())
			}
			list := next.s.List()
			if !canMount {
				if len(list) != 0 {
					t.Fatalf("started again on a computer that cannot mount: %+v", list)
				}
				rows := next.stoppedRows()
				if len(rows) != 1 || rows[0].Folder != folder[len(folder)-16:] ||
					rows[0].Pending == nil || *rows[0].Pending != 1 {
					t.Fatalf("stopped mounts %+v", rows)
				}
				return
			}
			if len(list) != 1 || list[0].ID != m.ID || list[0].MountPoint != mp {
				t.Fatalf("list %+v", list)
			}
			if got := next.ev.wait(t, m.ID, children.StatusRunning, children.StatusFailed); got.State != string(children.StatusRunning) {
				t.Fatalf("got %+v\n%s", got, next.lines.dump())
			}
			if next.folderOf(t, m.ID) != folder {
				t.Fatal("started again with another cache folder")
			}
			if len(next.stoppedRows()) != 0 {
				t.Fatalf("stopped mounts %+v", next.stoppedRows())
			}
		})
	}
}

// TestProbeThroughRclone runs the form's probe with rclone in this process (rclone.Run and the
// config's remotes) against a folder, a file, and a missing path.
func TestProbeThroughRclone(t *testing.T) {
	initRclone(t)
	f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
		o.list, o.stat = nil, nil
		o.RemoteNames = func() []string { return []string{"disk"} }
	}})
	_, mp := f.place("disk")
	var inv *errs.FieldError
	if _, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "disk", Enabled: true, RemotePath: "photos", MountPoint: mp}); err != nil {
		t.Fatalf("a folder: %v", err)
	}
	if _, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "disk", Enabled: true, RemotePath: "missing", MountPoint: mp + "2"}); !errors.As(err, &inv) || !strings.Contains(inv.Message, "was not found") {
		t.Fatalf("a missing path: %v", err)
	}
	if _, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "disk", Enabled: true, RemotePath: "photos/a.txt", MountPoint: mp + "3"}); !errors.As(err, &inv) || !strings.Contains(inv.Message, "is a file") {
		t.Fatalf("a file: %v", err)
	}
	// A link to a folder is a folder, as for /tmp on macOS. The mount follows it.
	link := filepath.Join(rcloneDisk, "linked")
	if err := os.Symlink(filepath.Join(rcloneDisk, "photos"), link); err != nil && !errors.Is(err, os.ErrExist) {
		t.Skip("no symlinks here:", err)
	}
	if _, err := f.s.SaveAutomount(f.ctx, Automount{Remote: "disk", Enabled: true, RemotePath: "linked", MountPoint: mp + "4"}); err != nil {
		t.Fatalf("a link to a folder: %v", err)
	}
	if problem, err := f.s.probeBoot(f.ctx, "disk", "photos"); problem != nil || err != nil {
		t.Fatalf("the start probe: %v %v", problem, err)
	}
	if problem, err := f.s.probeBoot(f.ctx, "disk", "missing"); problem == nil || !strings.Contains(problem.Error(), "was not found") || err != nil {
		t.Fatalf("the start probe of a missing path: %v %v", problem, err)
	}
	if err := f.s.listSource(f.ctx, "disk", "photos"); err != nil {
		t.Fatalf("listing the source: %v", err)
	}
	if err := f.s.listSource(f.ctx, "disk", "missing"); err == nil {
		t.Fatal("listing a missing source answered")
	}
	if problem, err := f.s.probeSource(f.ctx, "disk", "/"); problem != nil || err != nil {
		t.Fatalf("the probe of a root: %v %v", problem, err)
	}
}

var (
	rcloneOnce sync.Once
	rcloneDisk string
	rcloneErr  error
)

// initRclone initialises rclone in this process once (Init runs once per process). The config
// file has one remote, disk, which is an alias of a folder that holds photos/a.txt.
func initRclone(t *testing.T) {
	t.Helper()
	rcloneOnce.Do(func() {
		dir, err := os.MkdirTemp(testHome, "rclone-")
		if err != nil {
			rcloneErr = err
			return
		}
		rcloneDisk = filepath.Join(dir, "disk")
		if err := os.MkdirAll(filepath.Join(rcloneDisk, "photos"), 0o700); err != nil {
			rcloneErr = err
			return
		}
		if err := os.WriteFile(filepath.Join(rcloneDisk, "photos", "a.txt"), []byte("a"), 0o600); err != nil {
			rcloneErr = err
			return
		}
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, []byte("[disk]\ntype = alias\nremote = "+filepath.ToSlash(rcloneDisk)+"\n"), 0o600); err != nil {
			rcloneErr = err
			return
		}
		_, rcloneErr = rclone.Init(context.Background(), rclone.InitOptions{
			ConfigPath: conf, CacheDir: filepath.Join(dir, "cache"), LogLevel: "CRITICAL",
		})
	})
	if rcloneErr != nil {
		t.Fatal(rcloneErr)
	}
}

// TestBootDuringShutdown checks that a shutdown or planned restart that begins while Boot runs
// doesn't count as a mount failing. Nothing is notified, and the records that StopAll kept stay
// kept, so a mount from the previous run that Boot couldn't start comes back after the restart.
func TestBootDuringShutdown(t *testing.T) {
	t.Run("RestoreAfterStopAll", func(t *testing.T) {
		src := t.TempDir()
		mp := filepath.Join(t.TempDir(), "mnt")
		raw, _ := json.Marshal(meta{Args: operations.MountArgs{Source: src, Destination: mp}})
		rec := children.Record{ID: "0123abcd", Kind: children.KindMount, Name: mp, MountPoint: mp, Args: []string{"mount"}, Meta: raw}
		f := newFixture(t, fixtureOpts{pending: []children.Record{rec}})
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := f.sup.StopAll(ctx, func(children.Record) bool { return true }); err != nil {
			t.Fatal(err)
		}
		f.s.Boot(f.ctx)
		if n := f.notes.get(); len(n) != 0 {
			t.Fatalf("notified %+v", n)
		}
		if p := f.sup.Pending(); len(p) != 1 || p[0].ID != rec.ID {
			t.Fatalf("pending %+v, want the record StopAll kept", p)
		}
		lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: f.run})
		if len(lo.Restore) != 1 || lo.Restore[0].ID != rec.ID {
			t.Fatalf("children.json restores %+v", lo.Restore)
		}
	})

	t.Run("ProbeCancelled", func(t *testing.T) {
		probing := make(chan struct{}, 1)
		f := newFixture(t, fixtureOpts{tweak: func(o *Options) {
			o.RemoteNames = func() []string { return []string{"slow"} }
			o.stat = func(ctx context.Context, _, _ string) (bool, bool, error) {
				probing <- struct{}{}
				<-ctx.Done()
				return false, false, ctx.Err()
			}
		}})
		_, mp := f.place("slow")
		f.store(Automount{Remote: "slow", Enabled: true, RemotePath: "photos", MountPoint: mp, Options: writeBack})
		ctx, cancel := context.WithCancel(f.ctx)
		go func() {
			<-probing
			cancel()
		}()
		f.s.Boot(ctx)
		if n := f.notes.get(); len(n) != 0 || len(f.s.List()) != 0 {
			t.Fatalf("notified %+v, list %+v", n, f.s.List())
		}
	})
}

// TestLockedConfig checks that a mount from a config file with an unknown password is refused
// before anything starts, and that the error names the file.
func TestLockedConfig(t *testing.T) {
	f := newFixture(t)
	f.configs.err = errors.New("the config is encrypted: enter its password")
	src, mp := f.place("locked")
	_, err := f.s.Start(f.ctx, operations.MountArgs{Source: src, Destination: mp})
	var ce *children.ConfigError
	if !errors.As(err, &ce) || ce.Path != f.config {
		t.Fatalf("got %v", err)
	}
	if len(f.s.List()) != 0 || len(f.notes.get()) != 0 {
		t.Fatalf("list %+v, notified %+v", f.s.List(), f.notes.get())
	}
}

// TestEnabled checks that an automount runs when it is switched on and has a mount point. Its
// source is the remote's path, or the remote's root when there is no path.
func TestEnabled(t *testing.T) {
	all := []Automount{
		{Remote: "path", Enabled: true, RemotePath: "photos", MountPoint: "/mnt/photos"},
		{Remote: "path", Enabled: true, RemotePath: "docs", MountPoint: "/mnt/docs"},
		{Remote: "root", Enabled: true, MountPoint: "/mnt/root"},
		{Remote: "off", RemotePath: "photos", MountPoint: "/mnt/off"},
		{Remote: "nowhere", Enabled: true, RemotePath: "photos"},
	}
	got := enabled(all)
	if len(got) != 3 || got[0].args().Source != "path:photos" || got[1].args().Source != "path:docs" || got[2].args().Source != "root:" {
		t.Fatalf("enabled %+v", got)
	}
}
