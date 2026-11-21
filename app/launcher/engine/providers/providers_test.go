package providers

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/vfs"
)

// ms returns t in milliseconds since the epoch, the unit of a transfer's times.
func ms(t time.Time) *int64 {
	v := t.UnixMilli()
	return &v
}

// eta returns a transfer's seconds left.
func eta(s int64) *int64 { return &s }

// data returns a core state with three remotes (one of which can clean up and purge), a mount, a
// serve, two VFS caches, and a folder to complete in.
func data() *engine.Data {
	return &engine.Data{
		Remotes: []engine.Remote{
			{Name: "gdrive", Type: "drive", Features: map[string]bool{"CleanUp": true, "Purge": true}},
			{Name: "s3-backup", Type: "s3"},
			{Name: "My Box", Type: "box"},
		},
		Mounts: []mounts.MountRow{
			{ID: "m1", Source: "gdrive:", MountPoint: "/Volumes/gdrive", State: "running"},
		},
		Serves: []serves.ServeRow{
			{ID: "s1", Type: "http", Source: "s3-backup:", Addr: "127.0.0.1:8080", State: "running"},
		},
		Vfs: []vfs.VFS{
			{ID: "m1", Kind: "mount", Fs: "gdrive:", Name: "/Volumes/gdrive"},
			{ID: "s1", Kind: "serve", Fs: "s3-backup:", Name: "http 127.0.0.1:8080"},
		},
		ServeTypes: []string{"dlna", "ftp", "http", "nfs", "restic", "s3", "sftp", "webdav"},
		List: func(_ context.Context, dir string, page func([]engine.Entry)) error {
			if dir != "gdrive:" {
				return nil
			}
			page([]engine.Entry{
				{Name: "Photos", Path: "gdrive:Photos", Dir: true},
				{Name: "Projects", Path: "gdrive:Projects", Dir: true},
			})
			page([]engine.Entry{
				{Name: "photo.jpg", Path: "gdrive:photo.jpg"},
				{Name: ".hidden", Path: "gdrive:.hidden", Dir: true},
			})
			return nil
		},
	}
}

// run runs text through every provider and returns the final ranked results.
func run(t *testing.T, text string, d *engine.Data, usage engine.Usage) []engine.Result {
	t.Helper()
	c := NewCompletion()
	c.delay = 0
	e := engine.New(Operations{}, Running{}, Remotes{}, Navigation{}, Paths{}, c)
	q := engine.Parse(text, d.Remotes, d.Home)
	var last []engine.Result
	done := false
	e.Run(context.Background(), q, d, usage, func(rs []engine.Result, final bool) { last, done = rs, final })
	if !done {
		t.Fatalf("%q: no final snapshot", text)
	}
	return last
}

func titles(rs []engine.Result) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.Title
	}
	return out
}

// TestEmptyQueryListsTheGroups: the running items come first, then "Run" (which stands
// for the operations), the remotes and the app's screens, each group under its label.
func TestEmptyQueryListsTheGroups(t *testing.T) {
	rs := run(t, "", data(), nil)
	got := titles(rs)
	want := []string{"gdrive: → /Volumes/gdrive", "HTTP s3-backup: · 127.0.0.1:8080",
		"Run", "VFS",
		"gdrive", "s3-backup", "My Box", "Show Remotes", "New Remote",
		"Settings", "Commander", "GitHub", "History", "Guides", "Templates", "Watchers", "Schedules", "Automounts", "Notifications", "Remote Control", "Quit"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("empty query:\n got %q\nwant %q", got, want)
	}
	var groups []string
	for _, r := range rs {
		if len(groups) == 0 || groups[len(groups)-1] != r.Group {
			groups = append(groups, r.Group)
		}
	}
	if want := []string{engine.GroupActive, engine.GroupOperations, engine.GroupRemotes, engine.GroupApp}; !slices.Equal(groups, want) {
		t.Errorf("groups %q, want %q", groups, want)
	}
	idle := data()
	idle.Mounts, idle.Serves = nil, nil
	if rs := run(t, "", idle, nil); rs[0].Title != "Run" {
		t.Errorf("nothing running: first %q", rs[0].Title)
	}
}

// TestRecentsComeFirst: results that the history says are used come first in their group. The
// operations stay out of the empty query however much they are used.
func TestRecentsComeFirst(t *testing.T) {
	now := time.Now()
	usage := engine.Usage{
		"op:sync":          {Count: 5, Last: now.Add(-time.Hour)},
		"remote:s3-backup": {Count: 3, Last: now.Add(-2 * time.Hour)},
		"remote:gdrive":    {Count: 1, Last: now}, // a single use isn't a habit
	}
	got := titles(run(t, "", data(), usage))
	remotes := slices.Index(got, "s3-backup")
	if remotes < 0 || got[remotes+1] != "gdrive" || slices.Contains(got, "Sync") {
		t.Errorf("recents first: got %q", got)
	}
}

// TestOperationsWhenTyped: a word finds the operations that the empty query leaves out, and
// "Run" is found by its own words.
func TestOperationsWhenTyped(t *testing.T) {
	if got := titles(run(t, "sync", data(), nil)); len(got) == 0 || got[0] != "Sync" {
		t.Errorf("sync: got %q", got)
	}
	if got := titles(run(t, "wizard", data(), nil)); len(got) == 0 || got[0] != "Run" {
		t.Errorf("wizard: got %q", got)
	}
}

// TestActiveIsCapped: with more than four running items, the empty query lists three, plus a row
// that shows all of them, as "active" does.
func TestActiveIsCapped(t *testing.T) {
	d := data()
	for _, id := range []string{"m2", "m3", "m4"} {
		d.Mounts = append(d.Mounts, mounts.MountRow{ID: id, Source: id + ":", MountPoint: "/Volumes/" + id, State: "running"})
	}
	rs := run(t, "", d, nil)
	var active []string
	for _, r := range rs {
		if r.Group == engine.GroupActive {
			active = append(active, r.Title)
		}
	}
	if len(active) != activeMax || active[activeMax-1] != "Show All Running" {
		t.Fatalf("active: %q", active)
	}
	got := titles(run(t, "active ", d, nil))
	if len(got) != 6 || got[len(got)-1] != "Back" || slices.Contains(got, "Show All Running") {
		t.Errorf("active: %q", got)
	}
}

// TestTransfersAreActive: the queued and running transfers are one row, first among the running
// items, which opens the History window. "stop" offers to stop them, and to stop everything,
// saying what will stop.
func TestTransfersAreActive(t *testing.T) {
	d := data()
	d.Transfers = []transfers.Transfer{
		{ID: "t1", State: "running", Operation: "copy", Sources: []string{"gdrive:Photos"}, Destination: "/tmp/photos"},
		{ID: "t2", State: "queued", Operation: "delete", Sources: []string{"s3-backup:old"}},
	}
	rs := run(t, "", d, nil)
	if rs[0].Title != "2 Transfers" || rs[0].Subtitle != "1 running, 1 queued" || rs[0].Group != engine.GroupActive {
		t.Errorf("first: %q, %q, %q", rs[0].Title, rs[0].Subtitle, rs[0].Group)
	}
	if a, _ := rs[0].Default(); a.Name != "Open History" {
		t.Errorf("default: %q", a.Name)
	}
	d.Transfers = d.Transfers[:1]
	if rs := run(t, "", d, nil); rs[0].Title != "Copy gdrive:Photos → /tmp/photos" || rs[0].Subtitle != "Running" {
		t.Errorf("one transfer: %q, %q", rs[0].Title, rs[0].Subtitle)
	}
	got := run(t, "stop", d, nil)
	everything := slices.IndexFunc(got, func(r engine.Result) bool { return r.Title == "Stop Everything" })
	if everything < 0 || !slices.Contains(titles(got), "Stop Transfer") {
		t.Fatalf("stop: %q", titles(got))
	}
	a, _ := got[everything].Default()
	if a.Confirm != "Stop a transfer, a serve and a mount?" || !a.Stay {
		t.Errorf("stop everything asks %q (stays %v)", a.Confirm, a.Stay)
	}
	idle := data()
	idle.Mounts, idle.Serves = nil, nil
	if _, ok := StopEverything(idle); ok {
		t.Error("nothing runs: nothing to stop")
	}
	// The tunnel stops too, so the question names it.
	idle.Tunnel = true
	if r, ok := StopEverything(idle); !ok || r.Actions[0].Confirm != "Stop the remote tunnel?" {
		t.Errorf("the tunnel is on: %v, %+v", ok, r)
	}
}

// TestTransfersSayHowFar: once the core reports progress, the transfers row shows the combined
// progress instead of "Running".
func TestTransfersSayHowFar(t *testing.T) {
	d := data()
	d.Transfers = []transfers.Transfer{{ID: "t1", State: "running", Operation: "sync", Sources: []string{"/tmp/photos"},
		Destination: "gdrive:Photos", Live: &bus.TransferProgress{Bytes: 42 << 20, TotalBytes: 100 << 20, Speed: 12 << 20, Eta: eta(170)}}}
	rs := run(t, "", d, nil)
	if rs[0].Title != "Sync /tmp/photos → gdrive:Photos" || rs[0].Subtitle != "42% · 12 MB/s · 3 min left" {
		t.Errorf("one: %q, %q", rs[0].Title, rs[0].Subtitle)
	}
	d.Transfers = append(d.Transfers,
		transfers.Transfer{ID: "t2", State: "running", Operation: "copy", Sources: []string{"gdrive:a"}, Destination: "/tmp/a",
			Live: &bus.TransferProgress{Bytes: 8 << 20, TotalBytes: 100 << 20, Speed: 1 << 19}},
		transfers.Transfer{ID: "t3", State: "queued", Operation: "copy", Sources: []string{"gdrive:b"}, Destination: "/tmp/b"})
	if rs := run(t, "", d, nil); rs[0].Subtitle != "2 running, 1 queued · 25% · 12 MB/s" {
		t.Errorf("several: %q", rs[0].Subtitle)
	}
}

// TestFailedTransfers: a transfer that failed in the last day gets its own row among the running
// items, which opens its details. An older failure doesn't, and neither does a success.
func TestFailedTransfers(t *testing.T) {
	d := data()
	now := time.Now()
	d.Failed = []transfers.Transfer{
		{ID: "f1", State: "failed", Operation: "sync", Sources: []string{"/tmp/Photos"}, Destination: "gdrive:Photos",
			Error: "12 files couldn't be copied\nmore", EndedAt: ms(now.Add(-10 * time.Minute))},
		{ID: "f2", State: "failed", Operation: "delete", Sources: []string{"s3-backup:old"}, EndedAt: ms(now.Add(-25 * time.Hour))},
		// A watcher's run is left out: it runs every minute, and has its own window.
		{ID: "f3", State: "failed", Operation: "bisync", Sources: []string{"/tmp/a"}, Destination: "/tmp/b",
			Origin: transfers.Origin{Kind: transfers.OriginWatcher}, EndedAt: ms(now.Add(-time.Minute))},
		// A retry of a watcher's run is the user's own, so it is listed.
		{ID: "f4", State: "failed", Operation: "bisync", Sources: []string{"/tmp/a"}, Destination: "/tmp/b",
			Origin: transfers.Origin{Kind: transfers.OriginWatcher}, RetryOf: "f3", EndedAt: ms(now.Add(-time.Minute))},
	}
	rs := run(t, "", d, nil)
	if slices.ContainsFunc(rs, func(r engine.Result) bool { return r.ID == "run:failed:f3" }) {
		t.Error("a watcher's failed run is listed")
	}
	if !slices.ContainsFunc(rs, func(r engine.Result) bool { return r.ID == "run:failed:f4" }) {
		t.Error("a failed retry of a watcher's run is not listed")
	}
	i := slices.IndexFunc(rs, func(r engine.Result) bool { return r.ID == "run:failed:f1" })
	if i < 0 || rs[i].Title != "Sync failed: /tmp/Photos → gdrive:Photos" || rs[i].Group != engine.GroupActive ||
		rs[i].Subtitle != "Failed 10 min ago: 12 files couldn't be copied" {
		t.Fatalf("failed: %q", titles(rs))
	}
	if slices.ContainsFunc(rs, func(r engine.Result) bool { return r.ID == "run:failed:f2" }) {
		t.Error("a failure older than a day is listed")
	}
	e := &env{}
	a, _ := rs[i].Default()
	if err := a.Run(context.Background(), e); err != nil || !slices.Equal(e.calls, []string{"window History /history?id=f1"}) {
		t.Errorf("open: %v, %q", err, e.calls)
	}
	if got := titles(run(t, "failed", d, nil)); !slices.Contains(got, "Sync failed: /tmp/Photos → gdrive:Photos") {
		t.Errorf("failed: %q", got)
	}
	if got := titles(run(t, "s3-backup:", d, nil)); slices.Contains(got, "Sync failed: /tmp/Photos → gdrive:Photos") {
		t.Errorf("another path: %q", got)
	}
}

// TestProgressLine: the known parts of the progress, in a short line.
func TestProgressLine(t *testing.T) {
	for _, c := range []struct {
		p    corestate.Sum
		want string
	}{
		{corestate.Sum{Pct: -1}, ""},
		{corestate.Sum{Pct: 0}, "0%"},
		{corestate.Sum{Pct: 99, Speed: 900, Left: 20 * time.Second}, "99% · 900 B/s · less than a minute left"},
		{corestate.Sum{Pct: -1, Speed: 3 << 30, Left: 125 * time.Minute}, "3 GB/s · 2 h 5 min left"},
		{corestate.Sum{Pct: 5, Left: 2 * time.Hour}, "5% · 2 h left"},
	} {
		if got := progressLine(c.p); got != c.want {
			t.Errorf("%+v: %q, want %q", c.p, got, c.want)
		}
	}
}

// TestOpensMarksTheWindows: an action is marked Opens exactly when it opens one of the app's
// windows, so the launcher can make the app active for it.
func TestOpensMarksTheWindows(t *testing.T) {
	d := data()
	seen := 0
	for _, text := range []string{"", "gdrive:", "copy gdrive: /tmp", "https://example.com/f.zip gdrive:", "vfs ", "stop", "edit", "browse", "auto"} {
		for _, r := range run(t, text, d, nil) {
			for _, a := range r.Actions {
				if a.Run == nil {
					continue
				}
				e := &env{clip: "https://example.com/x.zip"}
				_ = a.Run(context.Background(), e)
				opened := slices.ContainsFunc(e.calls, func(c string) bool {
					return strings.HasPrefix(c, "window ") || strings.HasPrefix(c, "full ")
				})
				if opened != a.Opens {
					t.Errorf("%q › %q: opens a window %v, marked Opens %v", r.Title, a.Name, opened, a.Opens)
				}
				seen++
			}
		}
	}
	if seen < 50 {
		t.Fatalf("only %d actions run", seen)
	}
}

func TestFirstResult(t *testing.T) {
	cases := []struct{ text, first string }{
		{"copy", "Copy"},
		{"c", "Copy"},
		{"sync", "Sync"},
		{"copy gdrive: /tmp", "Copy gdrive: → /tmp"},
		// Sync is one-way and deletes, so it uses Copy's arrow, not Bisync's
		{"sync gdrive: /tmp", "Sync gdrive: → /tmp"},
		{"bisync gdrive: /tmp", "Bisync gdrive: ↔ /tmp"},
		{"gdrive: /tmp", "Copy gdrive: → /tmp"},
		{"https://example.com/f.zip gdrive:", "Download f.zip to gdrive:"},
		{"example.com/archive.tar", "Download archive.tar"},
		{"serve webdav gdrive:", "Serve gdrive: over WEBDAV"},
		{"settings", "Settings"},
		{"quit", "Quit"},
		{"gdr", "gdrive"},
		{"my box", "Browse My Box:"},
	}
	for _, c := range cases {
		rs := run(t, c.text, data(), nil)
		if len(rs) == 0 || rs[0].Title != c.first {
			t.Errorf("%q: first is %q, want %q (all: %q)", c.text, first(rs), c.first, titles(rs))
		}
	}
}

func first(rs []engine.Result) string {
	if len(rs) == 0 {
		return ""
	}
	return rs[0].Title
}

func TestContains(t *testing.T) {
	cases := []struct {
		text string
		has  []string
		not  []string
	}{
		// "mount gdrive:" offers Mount on the typed path
		{"mount gdrive:", []string{"Mount gdrive:"}, nil},
		// a path typed alone gets every operation that can start from it
		{"gdrive:", []string{"Browse gdrive:", "Copy from gdrive:", "Move from gdrive:", "Sync from gdrive:", "Bisync from gdrive:",
			"Mount gdrive:", "Serve gdrive:", "Download to gdrive:", "Delete gdrive:", "Purge gdrive:", "Clean up gdrive",
			"Edit gdrive", "New automount for gdrive"}, nil},
		{"s3-backup:", []string{"Browse s3-backup:"}, []string{"Purge s3-backup:", "Cleanup s3-backup"}},
		{"/tmp", []string{"Browse /tmp", "Copy from /tmp", "Mount /tmp", "Download to /tmp"}, []string{"Purge /tmp", "Edit /tmp"}},
		{"cleanup", []string{"Clean up gdrive"}, []string{"Cleanup s3-backup", "Cleanup"}},
		{"vfs", []string{"Forget the VFS cache of gdrive:", "Forget Every VFS Cache", "Back"}, nil},
		{"mount", []string{"Mount", "gdrive: → /Volumes/gdrive", "Unmount /Volumes/gdrive"}, nil},
		{"serve", []string{"Serve", "HTTP s3-backup: · 127.0.0.1:8080", "Stop HTTP s3-backup:"}, nil},
		{"stop", []string{"gdrive: → /Volumes/gdrive", "Unmount /Volumes/gdrive", "HTTP s3-backup: · 127.0.0.1:8080",
			"Stop HTTP s3-backup:"}, []string{"Unmount All", "Stop All Serves"}},
		// the Browse drill-in lists each remote, and Back
		{"browse", []string{"Browse gdrive", "Browse s3-backup", "Browse My Box", "Back"}, []string{"gdrive"}},
		{"browse gd", []string{"Browse gdrive"}, []string{"Back"}},
		{"gdr", []string{"gdrive"}, []string{"Browse gdrive", "Edit gdrive"}},
		{"edit", []string{"Edit gdrive", "Edit s3-backup", "Edit My Box"}, nil},
		{"auto mount", []string{"New automount for gdrive"}, nil},
		{"copy", nil, []string{"Back"}},
		{"schedules", []string{"Schedules"}, nil},
	}
	for _, c := range cases {
		got := titles(run(t, c.text, data(), nil))
		for _, h := range c.has {
			if !slices.Contains(got, h) {
				t.Errorf("%q: missing %q in %q", c.text, h, got)
			}
		}
		for _, n := range c.not {
			if slices.Contains(got, n) {
				t.Errorf("%q: unexpected %q in %q", c.text, n, got)
			}
		}
	}
}

// TestToolbarCommands: every command is found by its name and by its keywords.
func TestToolbarCommands(t *testing.T) {
	cases := []struct{ text, title string }{
		{"copy", "Copy"}, {"cp", "Copy"},
		{"move", "Move"}, {"mv", "Move"},
		{"sync", "Sync"}, {"synchronize", "Sync"},
		{"bisync", "Bisync"},
		{"mount", "Mount"},
		{"serve", "Serve"}, {"webdav", "Serve"},
		{"download", "Download"}, {"url", "Download"},
		{"cleanup", "Clean up gdrive"}, {"clean", "Clean up gdrive"},
		{"browse", "Browse gdrive"}, {"explore", "Browse gdrive"},
		{"delete", "Delete"}, {"rm", "Delete"},
		{"purge", "Purge"}, {"empty", "Purge"},
		{"settings", "Settings"}, {"preferences", "Settings"}, {"proxy", "Settings"},
		{"notifications", "Notifications"}, {"webhook", "Notifications"},
		{"mobile", "Remote Control"}, {"phone", "Remote Control"}, {"remote control", "Remote Control"},
		{"commander", "Commander"}, {"navigate", "Commander"}, {"explorer", "Commander"},
		{"github", "GitHub"}, {"issue", "GitHub"},
		{"transfers", "History"}, {"history", "History"},
		{"templates", "Templates"},
		{"watchers", "Watchers"}, {"dropbox", "Watchers"},
		{"schedules", "Schedules"}, {"cron", "Schedules"}, {"nightly", "Schedules"},
		{"new remote", "New Remote"}, {"create", "New Remote"},
		{"edit", "Edit gdrive"},
		{"auto mount", "New automount for gdrive"},
		{"show remotes", "Show Remotes"}, {"remotes", "Show Remotes"}, {"config", "Show Remotes"},
		{"quit", "Quit"}, {"exit", "Quit"},
		{"vfs", "Forget Every VFS Cache"}, {"forget", "Forget Every VFS Cache"},
	}
	for _, c := range cases {
		if got := titles(run(t, c.text, data(), nil)); !slices.Contains(got, c.title) {
			t.Errorf("%q: missing %q in %q", c.text, c.title, got)
		}
	}
	// the rows shown when there is nothing to list: no remote can clean up, none to browse, no
	// cache
	d := data()
	d.Remotes, d.Vfs = nil, nil
	for text, want := range map[string]string{"cleanup": "Cleanup", "browse": "Browse", "vfs": "VFS"} {
		if got := titles(run(t, text, d, nil)); !slices.Contains(got, want) {
			t.Errorf("%q with nothing: missing %q in %q", text, want, got)
		}
	}
}

// TestPanels: a remote, a path and a listed folder each offer every operation that can start from
// them.
func TestPanels(t *testing.T) {
	panel := func(text, title string) []string {
		t.Helper()
		for _, r := range run(t, text, data(), nil) {
			if r.Title == title {
				names := make([]string, len(r.Actions))
				for i, a := range r.Actions {
					names[i] = a.Name
				}
				return names
			}
		}
		t.Fatalf("%q: no %q", text, title)
		return nil
	}
	all := []string{"Browse", "Copy From", "Move From", "Sync From", "Bisync From", "Download Here", "Mount", "Serve", "Delete"}
	cases := []struct {
		text, title string
		want        []string
	}{
		{"gdr", "gdrive", append(all, "Purge", "Cleanup", "Edit Remote", "New Automount", "Copy Name")},
		{"s3-backup:x", "Browse s3-backup:x", append(all, "Edit Remote", "New Automount", "Copy Path")},
		{"/tmp", "Browse /tmp", append(all, "Reveal", "Copy Path")},
		{"gdrive:Pho", "Photos/", append(all, "Purge", "Cleanup", "Edit Remote", "New Automount", "Copy Path")},
		{"gdrive:photo.", "photo.jpg", []string{"Copy Path", "Copy From", "Move From", "Delete", "Cleanup", "Edit Remote"}},
	}
	for _, c := range cases {
		if got := panel(c.text, c.title); !slices.Equal(got, c.want) {
			t.Errorf("%q %q:\n got %q\nwant %q", c.text, c.title, got, c.want)
		}
	}
}

func TestCompletion(t *testing.T) {
	rs := run(t, "gdrive:pho", data(), nil)
	var entries []engine.Result
	for _, r := range rs {
		if strings.HasPrefix(r.ID, "complete:") {
			entries = append(entries, r)
		}
	}
	got := titles(entries)
	if !slices.Equal(got, []string{"Photos/", "photo.jpg"}) {
		t.Fatalf("entries %q", got)
	}
	if entries[0].Complete != "gdrive:Photos/" || !reflect.DeepEqual(entries[0].Match(), []int{0, 1, 2}) {
		t.Errorf("Photos: complete %q, match %v", entries[0].Complete, entries[0].Match())
	}
	// a hidden entry is offered only when its dot is typed, and nothing is offered for a path that
	// isn't being typed
	if got := titles(run(t, "gdrive:.h", data(), nil)); !slices.Contains(got, ".hidden/") {
		t.Errorf("dot typed: %q", got)
	}
	for _, r := range run(t, "gdrive: ", data(), nil) {
		if strings.HasPrefix(r.ID, "complete:") {
			t.Errorf("a path followed by a space is not being typed: %q", r.Title)
		}
	}
}

// slowList is a listing that sends its first page at once and the second after release. It
// counts how often it is called, and closes stopped if its context ends first.
type slowList struct {
	calls   atomic.Int32
	release chan struct{}
	stopped chan struct{}
	fail    bool
}

func newSlowList() *slowList {
	return &slowList{release: make(chan struct{}), stopped: make(chan struct{})}
}

func (l *slowList) list(ctx context.Context, dir string, page func([]engine.Entry)) error {
	l.calls.Add(1)
	page([]engine.Entry{{Name: "first", Path: dir + "first", Dir: true}})
	select {
	case <-ctx.Done():
		close(l.stopped)
		return ctx.Err()
	case <-l.release:
	}
	if l.fail {
		return errors.New("unreachable")
	}
	page([]engine.Entry{{Name: "fine", Path: dir + "fine"}})
	return nil
}

// typing returns a query that is typing the path text.
func typing(text string) engine.Query {
	return engine.Query{Typing: &engine.Path{Text: text, Remote: "gdrive"}}
}

// TestCompletionStreams: the first page is offered before the listing ends, and the rest once it
// ends.
func TestCompletionStreams(t *testing.T) {
	c := NewCompletion()
	c.delay = 0
	l := newSlowList()
	d := &engine.Data{List: l.list}
	partials := make(chan []string, 4)
	final := make(chan []string, 1)
	go func() {
		rs := c.QueryStream(context.Background(), typing("gdrive:f"), d, func(rs []engine.Result) { partials <- titles(rs) })
		final <- titles(rs)
	}()
	if got := <-partials; !slices.Equal(got, []string{"first/"}) {
		t.Fatalf("first page: %q", got)
	}
	close(l.release)
	if got := <-final; !slices.Equal(got, []string{"first/", "fine"}) {
		t.Fatalf("whole listing: %q", got)
	}
}

// TestCompletionSharesListing: further typing in a folder joins its listing rather than starting
// another, even when the newer query cancelled the earlier one.
func TestCompletionSharesListing(t *testing.T) {
	c := NewCompletion()
	c.delay = 0
	l := newSlowList()
	d := &engine.Data{List: l.list}
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan struct{})
	go func() {
		c.QueryStream(ctx, typing("gdrive:f"), d, func([]engine.Result) { close(got) })
	}()
	<-got
	cancel() // the next keystroke
	done := make(chan []string, 1)
	go func() {
		done <- titles(c.QueryStream(context.Background(), typing("gdrive:fi"), d, func([]engine.Result) {}))
	}()
	close(l.release)
	if rs := <-done; !slices.Equal(rs, []string{"fine", "first/"}) && !slices.Equal(rs, []string{"first/", "fine"}) {
		t.Fatalf("results %q", rs)
	}
	if n := l.calls.Load(); n != 1 {
		t.Fatalf("listed %d times", n)
	}
	// a finished listing is reused for the folder until Reset
	c.QueryStream(context.Background(), typing("gdrive:"), d, func([]engine.Result) {})
	if n := l.calls.Load(); n != 1 {
		t.Fatalf("listed %d times after it finished", n)
	}
}

// TestCompletionStopsOtherFolder: typing in another folder stops the unfinished listing of the
// first one, and a listing that failed is tried again.
func TestCompletionStopsOtherFolder(t *testing.T) {
	c := NewCompletion()
	c.delay = 0
	first := newSlowList()
	got := make(chan struct{})
	go c.QueryStream(context.Background(), typing("gdrive:a/"), &engine.Data{List: first.list}, func([]engine.Result) {
		select {
		case <-got:
		default:
			close(got)
		}
	})
	<-got
	second := newSlowList()
	close(second.release)
	c.QueryStream(context.Background(), typing("gdrive:b/"), &engine.Data{List: second.list}, func([]engine.Result) {})
	select {
	case <-first.stopped:
	case <-time.After(time.Second):
		t.Fatal("the first folder's listing went on")
	}

	failing := newSlowList()
	failing.fail = true
	close(failing.release)
	d := &engine.Data{List: failing.list}
	c.QueryStream(context.Background(), typing("gdrive:c/"), d, func([]engine.Result) {})
	c.QueryStream(context.Background(), typing("gdrive:c/"), d, func([]engine.Result) {})
	if n := failing.calls.Load(); n != 2 {
		t.Fatalf("a failed listing was asked %d times, want it tried again", n)
	}
}

// env records the calls that actions make.
type env struct {
	calls []string
	yes   bool
	clip  string
}

func (e *env) ClipboardText() string { return e.clip }

func (e *env) OpenWindow(name, url string) { e.calls = append(e.calls, "window "+name+" "+url) }
func (e *env) OpenFull(name, url string)   { e.calls = append(e.calls, "full "+name+" "+url) }
func (e *env) SetQuery(text string)        { e.calls = append(e.calls, "query "+text) }
func (e *env) Clipboard(text string)       { e.calls = append(e.calls, "clipboard "+text) }
func (e *env) Reveal(path string)          { e.calls = append(e.calls, "reveal "+path) }
func (e *env) OpenURL(url string)          { e.calls = append(e.calls, "url "+url) }
func (e *env) Notify(title, body string)   { e.calls = append(e.calls, "notify "+title+": "+body) }
func (e *env) Status(kind engine.StatusKind, text string) {
	if kind == engine.StatusDone {
		e.calls = append(e.calls, "done "+text)
	}
}
func (e *env) Ask(question, yes string) bool {
	e.calls = append(e.calls, "ask "+question)
	return e.yes
}
func (e *env) Quit()                 { e.calls = append(e.calls, "quit") }
func (e *env) Core() engine.Services { return engine.Services{} }

func TestDefaultActions(t *testing.T) {
	cases := []struct{ text, title, call string }{
		{"copy gdrive: /tmp", "Copy gdrive: → /tmp", "window Copy /copy?initialDestination=%2Ftmp&initialSource=gdrive%3A"},
		{"move /tmp", "Move from /tmp", "window Move /move?initialSource=%2Ftmp"},
		{"https://example.com/f.zip gdrive:", "Download f.zip to gdrive:", "window Download /download?initialDestination=gdrive%3A&initialUrl=https%3A%2F%2Fexample.com%2Ff.zip"},
		{"serve webdav gdrive:", "Serve gdrive: over WEBDAV", "window Serve /serve?initialSource=gdrive%3A&initialType=webdav"},
		{"gdrive:Photos", "Browse gdrive:Photos", "full Commander /commander?path=gdrive%3APhotos"},
		{"edit gdrive", "Edit gdrive", "window Remotes /remotes?action=edit&remote=gdrive"},
		{"new remote", "New Remote", "window Remotes /remotes?action=create"},
		{"mount", "gdrive: → /Volumes/gdrive", "reveal /Volumes/gdrive"},
		{"commander", "Commander", "full Commander /commander"},
		{"", "VFS", "query vfs "},
	}
	for _, c := range cases {
		var r *engine.Result
		for _, x := range run(t, c.text, data(), nil) {
			if x.Title == c.title {
				r = &x
				break
			}
		}
		if r == nil {
			t.Errorf("%q: no %q", c.text, c.title)
			continue
		}
		a, ok := r.Default()
		if !ok {
			if c.call != "" {
				t.Errorf("%q: %q has no action", c.text, c.title)
			}
			continue
		}
		e := &env{}
		if _, err := runAction(a, e); err != nil && c.call != "" {
			t.Errorf("%q: %v", c.text, err)
		}
		if c.call != "" && (len(e.calls) == 0 || e.calls[0] != c.call) {
			t.Errorf("%q: %q did %q, want %q", c.text, c.title, e.calls, c.call)
		}
	}
}

func TestStopsAskFirst(t *testing.T) {
	for _, text := range []string{"mount", "stop"} {
		for _, r := range run(t, text, data(), nil) {
			for _, a := range r.Actions {
				if (a.ID == "stop" || a.ID == "stop-all") && a.Confirm == "" {
					t.Errorf("%q: %q's %q doesn't ask first", text, r.Title, a.Name)
				}
			}
		}
	}
}

// TestQuitIsNeverARecent: Quit has no history key, so however often it is picked, an empty query
// never suggests it.
func TestQuitIsNeverARecent(t *testing.T) {
	now := time.Now()
	usage := engine.Usage{"nav:quit": {Count: 9, Last: now}} // as if Quit had been picked often
	rs := run(t, "", data(), usage)
	if rs[0].Title == "Quit" {
		t.Errorf("quit suggested: %q", titles(rs))
	}
	for _, r := range append(rs, run(t, "quit", data(), nil)...) {
		if r.Title == "Quit" && r.Key != "" {
			t.Errorf("Quit has the history key %q", r.Key)
		}
	}
}

// TestCompletionKeys: a completed folder is stored in the history under the same key as the typed
// folder, with or without a trailing separator. A folder offered for dropped files has its own
// key.
func TestCompletionKeys(t *testing.T) {
	keys := map[string]string{}
	for _, r := range run(t, "gdrive:Pho", data(), nil) {
		keys[r.Title] = r.Key
	}
	if keys["Photos/"] != "path:gdrive:Photos" || keys["photo.jpg"] != "path:gdrive:photo.jpg" {
		t.Errorf("completed: %q", keys)
	}
	for _, text := range []string{"gdrive:Photos", "gdrive:Photos/"} {
		for _, r := range run(t, text, data(), nil) {
			if r.Title == "Browse "+text && r.Key != "path:gdrive:Photos" {
				t.Errorf("%q: %q", text, r.Key)
			}
		}
	}
	if got := pathKey("/"); got != "path:/" {
		t.Errorf("the root: %q", got)
	}
	d := data()
	q := engine.Parse("gdrive:", d.Remotes, d.Home)
	q.Dropped = []engine.Path{{Text: "/nowhere/a.jpg", Local: true}}
	c := NewCompletion()
	c.delay = 0
	for _, r := range c.Query(context.Background(), q, d) {
		if want := "drop:path:gdrive:" + r.Title; r.Key != want {
			t.Errorf("drop destination %q: %q, want %q", r.Title, r.Key, want)
		}
	}
}

// TestCopyAddress: Copy Address copies only the serve's address, as the Serve page does, and
// says so in the notification.
func TestCopyAddress(t *testing.T) {
	d := data()
	d.Serves[0].Args = operations.ServeArgs{Type: "http", Options: operations.Groups{Serve: catalog.Group{"user": []byte(`"me"`), "pass": []byte(`"secret"`)}}}
	copied := 0
	for _, r := range run(t, "serve", d, nil) {
		for _, a := range r.Actions {
			if a.Name != "Copy Address" {
				continue
			}
			copied++
			e := &env{}
			if _, err := runAction(a, e); err != nil {
				t.Fatal(err)
			}
			addr := d.Serves[0].Addr
			want := []string{"clipboard " + addr, "notify Address Copied: " + addr + " copied to clipboard"}
			if !slices.Equal(e.calls, want) {
				t.Errorf("%q: did %q, want %q", r.Title, e.calls, want)
			}
		}
	}
	if copied == 0 {
		t.Fatal("no Copy Address")
	}
}

// TestDropped: dropped files go to a remote, a typed path, or a place chosen later. A single
// folder can also be synced, served and browsed. Completion lists only folders, as destinations.
func TestDropped(t *testing.T) {
	d := data()
	files := []engine.Path{{Text: "/nowhere/a.jpg", Local: true}, {Text: "/nowhere/b.jpg", Local: true}}
	q := engine.Parse("", d.Remotes, d.Home)
	q.Dropped = files
	got := titles(Dropped{}.Query(context.Background(), q, d))
	if !slices.Contains(got, "Copy 2 items to gdrive:") || !slices.Contains(got, "Move 2 items to…") || slices.Contains(got, "Sync 2 items to…") {
		t.Fatalf("two files: %q", got)
	}

	dir := t.TempDir()
	q.Dropped = []engine.Path{{Text: dir, Local: true}}
	got = titles(Dropped{}.Query(context.Background(), q, d))
	name := filepath.Base(dir)
	for _, want := range []string{"Sync " + name + " to…", "Serve " + name, "Browse " + name} {
		if !slices.Contains(got, want) {
			t.Errorf("a folder: %q lacks %q", got, want)
		}
	}

	q = engine.Parse("gdrive:", d.Remotes, d.Home)
	q.Dropped = files
	c := NewCompletion()
	c.delay = 0
	var dests []string
	for _, r := range c.Query(context.Background(), q, d) {
		dests = append(dests, r.Title)
		a, _ := r.Default()
		e := &env{}
		_, _ = runAction(a, e)
		if want := "window Copy /copy?initialDestination=gdrive%3A" + strings.TrimSuffix(r.Title, "/") + "%2F&initialSource=%2Fnowhere%2Fa.jpg&initialSource=%2Fnowhere%2Fb.jpg"; len(e.calls) != 1 || e.calls[0] != want {
			t.Errorf("%s: %q", r.Title, e.calls)
		}
	}
	if !slices.Equal(dests, []string{"Photos/", "Projects/"}) {
		t.Fatalf("completion's destinations: %q", dests)
	}
}

// TestClipboard: a link or path that was just copied is suggested first on the empty query. A
// link whose text isn't known yet is read when chosen. Anything else, or a typed query, gets no
// suggestion.
func TestClipboard(t *testing.T) {
	d := data()
	ask := func(clip engine.Clip, text string) []engine.Result {
		q := engine.Parse(text, d.Remotes, d.Home)
		q.Clipboard = clip
		return Clipboard{}.Query(context.Background(), q, d)
	}
	if got := titles(ask(engine.Clip{Text: "https://example.com/a/movie.mkv"}, "")); !slices.Equal(got, []string{"Download movie.mkv"}) {
		t.Errorf("link: %q", got)
	}
	if got := titles(ask(engine.Clip{Text: "gdrive:Photos/2024"}, "")); !slices.Equal(got, []string{"Browse gdrive:Photos/2024"}) {
		t.Errorf("path: %q", got)
	}
	for _, text := range []string{"report.pdf", "two\nlines", "hello world"} {
		if got := ask(engine.Clip{Text: text}, ""); len(got) != 0 {
			t.Errorf("%q: %q", text, titles(got))
		}
	}
	if got := ask(engine.Clip{Text: "https://example.com/x"}, "co"); len(got) != 0 {
		t.Errorf("a query typed: %q", titles(got))
	}
	rs := ask(engine.Clip{Link: true}, "")
	if len(rs) != 1 || rs[0].Title != "Download the Link You Copied" || !rs[0].Pinned {
		t.Fatalf("an unread link: %+v", rs)
	}
	e := &env{clip: "https://example.com/x.zip"}
	a, _ := rs[0].Default()
	_, _ = runAction(a, e)
	if len(e.calls) != 1 || e.calls[0] != "window Download /download?initialUrl=https%3A%2F%2Fexample.com%2Fx.zip" {
		t.Fatalf("read when chosen: %q", e.calls)
	}
	// pinned above the empty query's recent results
	ranked := engine.Rank(engine.Query{}, append(ask(engine.Clip{Text: "https://example.com/a/movie.mkv"}, ""),
		engine.Result{ID: "r", Key: "r", Title: "Recent"}), engine.Usage{"r": {Count: 5, Last: time.Now()}}, time.Now())
	if ranked[0].Title != "Download movie.mkv" {
		t.Errorf("ranked: %q", titles(ranked))
	}
}

// runAction runs a, as the launcher does once any question is answered.
func runAction(a engine.Action, e *env) (bool, error) {
	if a.Run == nil {
		return true, nil
	}
	return true, a.Run(context.Background(), e)
}

// TestOpenInBrowser: a serve on every interface opens at 127.0.0.1, and one on a specific address
// opens at that address.
func TestOpenInBrowser(t *testing.T) {
	for _, c := range []struct{ addr, want string }{
		{":8080", "http://127.0.0.1:8080"},
		{"0.0.0.0:8083", "http://127.0.0.1:8083"},
		{"[::]:8084", "http://127.0.0.1:8084"},
		{"127.0.0.1:8081", "http://127.0.0.1:8081"},
		{"192.168.1.5:8082", "http://192.168.1.5:8082"},
	} {
		d := data()
		d.Serves[0].Addr = c.addr
		got := ""
		for _, r := range run(t, "serve", d, nil) {
			if r.ID != "run:serve:s1" {
				continue
			}
			for _, a := range r.Actions {
				if a.ID != "browser" {
					continue
				}
				e := &env{}
				if _, err := runAction(a, e); err != nil {
					t.Fatal(err)
				}
				got = strings.TrimPrefix(e.calls[0], "url ")
			}
		}
		if got != c.want {
			t.Errorf("%s: opened %q, want %q", c.addr, got, c.want)
		}
	}
}

// TestRowsMatchBothLanguages: in another language (the test language, Pseudo, stands in for
// one), the rows are drawn translated, and typing finds them by their English titles and search
// words as well as by their translated ones. A drill-in types its word in the app's language.
func TestRowsMatchBothLanguages(t *testing.T) {
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	for _, c := range []struct{ typed, want string }{
		{"copy", "[Çópý]"},               // an operation's English title
		{"çópý", "[Çópý]"},               // and its translation
		{"settings", "[Séttíñgs]"},       // a screen's English title
		{"preferences", "[Séttíñgs]"},    // and an English search word
		{"préféréñçés", "[Séttíñgs]"},    // and its translation
		{"new remote", "[Ñéw Rémóté]"},   // two English words
		{"edit gdrive", "[Édít gdrive]"}, // a command word and a name
		{"unmount", "[Úñmóúñt /Volumes/gdrive]"},
	} {
		if got := titles(run(t, c.typed, data(), nil)); !slices.Contains(got, c.want) {
			t.Errorf("%q: %q lacks %q", c.typed, got, c.want)
		}
	}
	if got := titles(run(t, "browse", data(), nil)); !slices.Contains(got, "[Brówsé gdrive]") {
		t.Errorf("browse: %q lacks the remotes to browse", got)
	}

	d := data()
	for i := range 5 {
		d.Mounts = append(d.Mounts, mounts.MountRow{ID: fmt.Sprint("m", i+2), Source: "s3-backup:", MountPoint: fmt.Sprint("/m", i)})
	}
	rs := run(t, "", d, nil)
	i := slices.IndexFunc(rs, func(r engine.Result) bool { return r.ID == "run:all" })
	if i < 0 {
		t.Fatalf("no row that lists everything running: %q", titles(rs))
	}
	e := &env{}
	a, _ := rs[i].Default()
	_, _ = runAction(a, e)
	if len(e.calls) != 1 || !strings.HasPrefix(e.calls[0], "query ") {
		t.Fatalf("show all: %q", e.calls)
	}
	typed := strings.TrimPrefix(e.calls[0], "query ")
	if !strings.HasPrefix(typed, "[áçtívé") {
		t.Errorf("the drill-in typed %q, not its word in the app's language", typed)
	}
	for _, q := range []string{typed, "active "} {
		if got := titles(run(t, q, d, nil)); !slices.Contains(got, "[Báçk]") {
			t.Errorf("%q: no way back in %q", q, got)
		}
	}
}
