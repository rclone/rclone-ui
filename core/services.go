package core

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/favorites"
	"github.com/rclone/rclone-ui/core/files"
	"github.com/rclone/rclone-ui/core/httpx"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/keychain"
	"github.com/rclone/rclone-ui/core/launcher"
	"github.com/rclone/rclone-ui/core/linkresolve"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/media"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/prefs"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/remotes"
	"github.com/rclone/rclone-ui/core/schedules"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/settings"
	"github.com/rclone/rclone-ui/core/templates"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/tunnel"
	"github.com/rclone/rclone-ui/core/vfs"
	"github.com/rclone/rclone-ui/core/watchers"
)

// notifyTimeout is the time limit for each delivery of a notification.
const notifyTimeout = 15 * time.Second

// startServices creates the core's services and starts them, in four steps:
//
//  1. openRclone: the settings and the config file, then rclone's init, which gives the store.
//  2. build: every other service, each after the services it uses. Building starts nothing.
//  3. start: what each service does once at the start, in order.
//  4. background: the work that starts once every service is up.
//
// Where two services need each other, one reaches the other later, through a closure or a
// subscription: configs.Attach, configUsers, settings.OnBwLimit and remotes.Start.
func (c *Core) startServices(ctx context.Context) error {
	if err := c.openRclone(ctx); err != nil {
		return fmt.Errorf("rclone: %w", err)
	}
	if err := c.build(); err != nil {
		return err
	}
	if err := c.start(ctx); err != nil {
		return err
	}
	c.background()
	return nil
}

// openRclone creates the services that rclone's init needs, and then sets up rclone's process-wide
// state with the config file. A config file that can't be read (a wrong or missing password, or a
// broken file) doesn't stop the core. The store reports the problem, and the pages ask the user
// to fix it.
func (c *Core) openRclone(ctx context.Context) error {
	c.keychain = keychain.New(c.dataDir)
	c.settings = settings.New(c.db, c.bus)
	c.prefs = prefs.New(c.db, c.bus)
	c.configs = config.New(config.Options{DB: c.db, Bus: c.bus, Secrets: c.keychain, InUse: c.configUsers})
	path, password, err := c.configs.Prepare(ctx)
	if err != nil {
		return err
	}
	saved, err := c.settings.Get(ctx)
	if err != nil {
		return err
	}
	i18n.SetLanguage(saved.General.Language)
	limit, err := settings.BwLimit(saved.Transfers.BwLimit)
	if err != nil {
		return err
	}
	store, err := rclone.Init(ctx, rclone.InitOptions{
		ConfigPath:     path,
		ConfigPassword: password,
		CacheDir:       filepath.Join(c.dataDir, datadir.CacheDir),
		LogLevel:       c.opts.LogLevel,
		Proxy:          rclone.Proxy{URL: saved.Proxy.URL, IgnoredHosts: saved.Proxy.IgnoredHosts},
		BwLimit:        limit,
	})
	if err != nil {
		return err
	}
	c.store = store
	// The config's service needs the store, which rclone's init only creates once the service
	// has found the file and its password.
	c.configs.Attach(store)
	// The Settings page shows the config's state, such as a password being needed, a save being
	// refused, or a password removed outside the app.
	store.OnState(func(st rclone.State) {
		c.configs.StateChanged(st)
		c.bus.Publish(bus.ConfigChanged, nil)
	})
	st := store.State()
	logs.Logger(logs.CompApp, "rclone").InfoContext(ctx, "config", "path", st.Path, "status", string(st.Status))
	return nil
}

// build creates the other services, each after the services it uses. Building a service starts
// no goroutine and writes nothing, so a boot that fails here leaves nothing to stop. Only the
// children's supervisor can fail, when its sockets' folder is too long.
func (c *Core) build() error {
	c.telemetry = c.newTelemetry()
	c.templates = templates.New(c.db, c.bus, c.exe)
	c.favorites = favorites.New(c.db, c.bus)
	c.launcher = launcher.New(c.db)
	// The link resolution for the Download page goes through the same proxy as the download
	// itself.
	c.links = linkresolve.New(httpx.New(linkresolve.Timeout), linkresolve.Service)
	lister := browse.NewLister()
	c.lister = lister
	c.notifications = notifications.New(c.db, c.keychain, c.bus, httpx.New(notifyTimeout), c)

	cacheDir := filepath.Join(c.dataDir, datadir.CacheDir)
	sup, err := children.New(children.Options{
		RunDir:      c.runDir,
		SocketDir:   c.socketDir,
		Exe:         c.exe,
		CacheDir:    cacheDir,
		Emit:        c.logs.Append,
		LibraryPath: c.libraryPath,
	})
	if err != nil {
		return fmt.Errorf("children: %w", err)
	}
	c.children = sup
	c.mounts = mounts.New(mounts.Options{
		DB: c.db, Bus: c.bus, Notifier: c.notifications, Children: sup, Configs: c.configs,
		RemoteNames: c.store.GetSectionList, CacheRoot: cacheDir, Executable: c.exe,
		PointChanged: func(mountPoint string) { lister.InvalidatePaths(mountPoint) },
	})
	c.serves = serves.New(serves.Options{
		Bus: c.bus, Notifier: c.notifications, Children: sup, Configs: c.configs, Executable: c.exe,
		Secrets: c.keychain,
	})
	c.vfs = vfs.New(c.mountVFSes, c.serveVFSes)
	c.tunnel = tunnel.New(tunnel.Options{DB: c.db, Bus: c.bus, Children: sup, Configs: c.configs})

	// A transfer that ends (including a resumed one) drops the listings it changed.
	c.transfers = transfers.New(transfers.Options{
		DB: c.db, Bus: c.bus, Notifier: c.notifications, Run: c,
		Ended: func(t transfers.Transfer) {
			lister.TransferEnded(t.Operation, t.Sources, t.Destination)
			c.transferEnded(t)
		},
	})
	// The watchers and the schedules run through the transfers. The runs that a quit cut short
	// run again, unless the app crashed. The schedules' runs that catch up after the start wait
	// until the config is unlocked.
	c.watchers = watchers.New(watchers.Options{
		DB: c.db, Bus: c.bus, Transfers: c.transfers, Notifier: c.notifications, Run: c,
	})
	c.schedules = schedules.New(schedules.Options{
		DB: c.db, Bus: c.bus, Transfers: c.transfers, Templates: c.templates, Watchers: c.watchers,
		Notifier: c.notifications, Run: c, Crashed: c.crashed, Locked: c.configs.Locked,
	})
	// The Commander's file actions. Those that take long run as transfers, and a single-file
	// delete is recorded as one.
	c.files = files.New(c.bus, lister, c.transfers)
	// The server for the signed media URLs, which listens on its own loopback port once started.
	c.media = media.NewSigner()

	// A change of the config's remotes drops their listings, and flags the mounts and serves that
	// use them. A rename rewrites what names the remote: the favorites, the templates, the
	// automounts, the watchers' folders and the schedules' forms.
	c.remotes = remotes.New(remotes.Options{
		DB: c.db, Store: c.store, Bus: c.bus, Run: c, Config: c.configs, Invalidator: lister,
		Followers: []remotes.Follower{c.favorites, c.templates, c.mounts, c.watchers, c.schedules},
		Edited:    c.childRemotesChanged,
	})
	c.built = true
	return nil
}

// start runs what each service does once at the start, in order. Nothing calls a service before
// it ends, because the APIs get their services only once the boot is done.
func (c *Core) start(ctx context.Context) error {
	if err := c.launcher.Prune(ctx); err != nil {
		// Stale entries only affect the launcher's ranking for a while longer, so this error
		// shouldn't stop the start.
		logs.Logger(logs.CompApp, "launcher").ErrorContext(ctx, "pruning the launcher's usage history", "error", err)
	}
	if err := c.media.Listen(); err != nil {
		return fmt.Errorf("browse: serving the media URLs: %w", err)
	}
	// The notifications' queue holds what was sent before this, and the transfers and the
	// children send notifications from now on.
	c.notifications.Start()
	if c.crashed {
		c.notifications.Notify(ctx, notifications.NotificationEventAppCrashed, notifications.Crashed{Crashes: 1})
	}
	// The remotes listen to the store before it watches the file, so no edit made outside the app
	// is missed.
	c.remotes.Start(ctx)
	c.Go("config.watch", c.store.Watch)
	c.settings.OnBwLimit(c.setBwLimit)
	c.startTelemetry(ctx)
	if err := c.startChildren(ctx); err != nil {
		return fmt.Errorf("children: %w", err)
	}
	// Before anything can start a transfer, the transfers that the previous run left open are
	// settled. At Shutdown, the running transfers are marked as interrupted, or, on an update's
	// restart, marked to start again.
	var last int64
	if prev := c.logs.Previous(); !prev.IsZero() {
		last = prev.UnixMilli()
	}
	if err := c.transfers.Recover(ctx, last); err != nil {
		return fmt.Errorf("transfers: %w", err)
	}
	return nil
}

// background starts what was running before, and the mounts set to start with the app, and the
// watchers' and the schedules' schedulers. It runs once every service is up.
func (c *Core) background() {
	c.GoOnce("mounts.boot", c.mounts.Boot)
	c.GoOnce("serves.boot", c.serves.Boot)
	c.GoOnce("tunnel.boot", c.tunnel.Boot)
	c.Go("watchers", c.watchers.Run)
	c.Go("schedules", c.schedules.Run)
}

// setBwLimit applies a new bandwidth limit at once: to the core's transfers, and through their rc
// to the mounts and serves that are running. Those that start later get it from rclone's options.
func (c *Core) setBwLimit(ctx context.Context, limit string) {
	pair, err := settings.BwLimit(limit)
	if err != nil {
		return // Update refuses it first
	}
	rclone.SetBwLimit(pair)
	rate := "off"
	if pair.IsSet() {
		rate = pair.String()
	}
	log := logs.Logger(logs.CompApp, "rclone")
	var rcs []*children.RC
	for _, m := range c.mounts.List() {
		rcs = append(rcs, c.mounts.RC(m.ID))
	}
	for _, v := range c.serves.List() {
		rcs = append(rcs, c.serves.RC(v.ID))
	}
	for _, r := range rcs {
		if r == nil {
			continue
		}
		if _, err := r.Call(ctx, "core/bwlimit", rc.Params{"rate": rate}); err != nil {
			log.WarnContext(ctx, "setting a child's bandwidth limit", "error", err)
		}
	}
}

// configUsers lists the children, which all use the config file. Changing the file's password
// waits for them to stop. The mounts, the serves and the tunnel are built after the config's
// service, which gets this function. Reading them here is safe, because only a page can change
// the password, and the pages reach the services after the boot.
func (c *Core) configUsers() []i18n.Text {
	var out []i18n.Text
	for _, m := range c.mounts.List() {
		// i18n: A running mount that uses the config file, as in "Mount gdrive: at /Volumes/gdrive".
		out = append(out, i18n.M("Mount %s at %s", m.Source, m.MountPoint))
	}
	for _, v := range c.serves.List() {
		// i18n: A running serve that uses the config file, as in "Serve gdrive: over HTTP at 127.0.0.1:8080".
		out = append(out, i18n.M("Serve %s over %s at %s", v.Source, strings.ToUpper(v.Type), v.Addr))
	}
	if c.tunnel.Status().State != tunnel.StateOff {
		out = append(out, i18n.M("The remote tunnel"))
	}
	return out
}

// startChildren kills the children that a previous run left (listed in children.json). It
// clears every broken mount point, both the recorded ones and those of the mounts set to start
// with the app, and removes stale sockets and key files. Then the supervisor begins with the
// mounts and serves to start again: those that a planned restart kept, or that were running when
// the previous run crashed.
func (c *Core) startChildren(ctx context.Context) error {
	log := logs.Logger(logs.CompChildren, logs.SubSupervisor)
	points, err := mounts.AutomountPoints(ctx, c.db, runtime.GOOS)
	if err != nil {
		log.ErrorContext(ctx, "could not read the automounts; only the recorded mount points are checked", "error", err)
	}
	lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: c.runDir, SocketDir: c.socketDir, Automounts: points})
	return c.children.Begin(lo.Restore)
}

// childRemotesChanged flags the running mounts and serves that use one of the remotes that
// changed. Their processes keep what they read when they started, so their rows say "Restart to
// apply" until they start again.
func (c *Core) childRemotesChanged(names []string) {
	uses := func(source string) bool { return rclone.Mentions(source, names) }
	c.mounts.RemotesChanged(uses)
	c.serves.RemotesChanged(uses)
}

// stopChildren stops every child (which unmounts the mounts) and waits for each one, so no child
// outlives the app. On an update's restart, the mounts and serves that were running stay listed
// in children.json so they start again.
func (c *Core) stopChildren(ctx context.Context, restart bool) {
	var keep func(children.Record) bool
	if restart {
		keep = func(children.Record) bool { return true }
	}
	if err := c.children.StopAll(ctx, keep); err != nil {
		logs.Logger(logs.CompApp, logs.SubShutdown).WarnContext(ctx, "stopping the children", "error", err)
	}
	c.mounts.Shutdown(ctx, restart)
	c.serves.Shutdown(restart)
}

// mountVFSes and serveVFSes list the children's VFSes for the VFS page.
func (c *Core) mountVFSes() []vfs.Target {
	var out []vfs.Target
	for _, m := range c.mounts.List() {
		out = append(out, vfs.Target{ID: m.ID, Kind: "mount", Fs: m.Source, Name: m.MountPoint, RC: c.mounts.RC(m.ID)})
	}
	return out
}

func (c *Core) serveVFSes() []vfs.Target {
	var out []vfs.Target
	for _, v := range c.serves.List() {
		if v.Type == "restic" { // a restic serve doesn't use a VFS
			continue
		}
		out = append(out, vfs.Target{ID: v.ID, Kind: "serve", Fs: v.Source, Name: v.Type + " " + v.Addr, RC: c.serves.RC(v.ID)})
	}
	return out
}

// BusyItem is one thing that a quit or an update would interrupt.
type BusyItem struct {
	// Kind is "transfer", "mount", "serve" or "tunnel".
	Kind string
	ID   string
	// Label is the name the user knows it by ("Copy gdrive:Photos → /Volumes/Backup").
	Label string
	// Detail explains why it matters ("3 files not uploaded yet" for a mount's dirty cache).
	Detail string
}

type BusyList struct {
	Items []BusyItem
	// Running counts the items by kind, which the dialog's text names with Running.Phrase.
	Running Running
}

// Busy lists what a quit or an update would interrupt. It is the same set that StopAll stops.
func (c *Core) Busy(ctx context.Context) BusyList {
	items := c.busyTransfers(ctx)
	items = append(items, c.busyChildren(ctx)...)
	items = append(items, c.busyTunnel()...)
	var r Running
	for _, it := range items {
		switch it.Kind {
		case "transfer":
			r.Transfers++
		case "mount":
			r.Mounts++
		case "serve":
			r.Serves++
		case "tunnel":
			r.Tunnel = true
		}
	}
	return BusyList{Items: items, Running: r}
}

// Running counts what the core runs that a stop ends. A watcher's or a schedule's run counts as a
// transfer. Busy, StopAll and the launcher all use it and name it with Phrase, so that a question
// names exactly what its answer stops.
type Running struct {
	Transfers, Mounts, Serves int
	// Tunnel is set while the remote tunnel is on or starting.
	Tunnel bool
}

// Phrase names what r counts, for a question or a message: "2 transfers, a serve and 3 mounts",
// "a mount and the remote tunnel". It is "" when r counts nothing.
func (r Running) Phrase() i18n.Text {
	var parts []i18n.Text
	if r.Transfers > 0 {
		// i18n: Part of a list of what is running, as in "Stop 2 transfers and a mount?".
		parts = append(parts, i18n.MN("a transfer", "%d transfers", r.Transfers, r.Transfers))
	}
	if r.Serves > 0 {
		// i18n: Part of a list of what is running, as in "Stop 2 transfers and a serve?".
		parts = append(parts, i18n.MN("a serve", "%d serves", r.Serves, r.Serves))
	}
	if r.Mounts > 0 {
		// i18n: Part of a list of what is running, as in "Stop a transfer and 3 mounts?".
		parts = append(parts, i18n.MN("a mount", "%d mounts", r.Mounts, r.Mounts))
	}
	if r.Tunnel {
		// i18n: Part of a list of what is running, as in "Stop a mount and the remote tunnel?".
		parts = append(parts, i18n.M("the remote tunnel"))
	}
	return i18n.List(parts)
}

type StopSummary struct{ Running }

// Done says what StopAll stopped: "Stopped 2 transfers, a serve and 3 mounts.", or "Nothing was
// running." when it stopped nothing.
func (s StopSummary) Done() i18n.Text {
	if p := s.Phrase(); !p.IsZero() {
		// i18n: %s names what was stopped: "2 transfers, a serve and 3 mounts".
		return i18n.M("Stopped %s.", p)
	}
	return i18n.M("Nothing was running.")
}

// Kept counts the watchers and schedules that run while the app is open (KeepsRunning).
type Kept struct {
	Watchers  int `json:"watchers"`
	Schedules int `json:"schedules"`
}

// KeepsRunning counts the watchers and schedules that would run if the app stayed open: those
// that aren't paused, and for watchers, that don't wait for the user. The quit dialog says they
// won't run while the app is closed.
func (c *Core) KeepsRunning(ctx context.Context) Kept {
	var k Kept
	log := logs.Logger(logs.CompTransfers, "")
	n, err := c.watchers.Active(ctx)
	if err != nil {
		log.WarnContext(ctx, "counting the watchers", "error", err)
	}
	k.Watchers = n
	if n, err = c.schedules.Active(ctx); err != nil {
		log.WarnContext(ctx, "counting the schedules", "error", err)
	}
	k.Schedules = n
	return k
}

// The busy items' labels and details are in the app's language: the quit and update dialogs show
// them as soon as they are listed.

func (c *Core) busyTransfers(ctx context.Context) []BusyItem {
	active, err := c.transfers.Active(ctx)
	if err != nil {
		logs.Logger(logs.CompTransfers, "").WarnContext(ctx, "reading the running transfers", "error", err)
		return nil
	}
	items := make([]BusyItem, 0, len(active))
	for _, tr := range active {
		name, sources := transfers.OperationName(tr.Operation), strings.Join(tr.Sources, ", ")
		label := name + " " + sources
		if tr.Destination != "" {
			// i18n: A running transfer in a list: its operation's name ("Sync"), its sources, and where they go.
			label = i18n.T("%[1]s %[2]s → %[3]s", name, sources, tr.Destination)
		}
		items = append(items, BusyItem{Kind: "transfer", ID: tr.ID, Label: label, Detail: busyDetail(tr)})
	}
	return items
}

// busyDetail says what happens to a running transfer after a stop: one from the pages starts
// again after an update, and a schedule's run runs again at the next start, whatever the stop. A
// retry of a schedule's run is the user's own, so the schedule doesn't run it again.
func busyDetail(tr transfers.Transfer) string {
	switch {
	case transfers.Resumable(tr):
		return i18n.T("Starts again after an update.")
	case tr.Origin.Kind == transfers.OriginSchedule && tr.RetryOf == "":
		return i18n.T("Runs again when Rclone UI starts.")
	}
	return ""
}

func (c *Core) busyChildren(ctx context.Context) []BusyItem {
	var items []BusyItem
	for _, m := range c.mounts.Busy(ctx, false) {
		detail := ""
		if m.UploadsPending > 0 {
			detail = i18n.N("%d file not uploaded yet", "%d files not uploaded yet", m.UploadsPending, m.UploadsPending)
		}
		// i18n: A running mount in a list: its source, and its mount point.
		label := i18n.T("Mount %[1]s at %[2]s", m.Source, m.MountPoint)
		items = append(items, BusyItem{Kind: "mount", ID: m.ID, Label: label, Detail: detail})
	}
	for _, v := range c.serves.Busy(false) {
		// i18n: A running serve in a list: its source, its protocol (HTTP, WebDAV…) and its address.
		label := i18n.T("Serve %[1]s over %[2]s at %[3]s", v.Source, strings.ToUpper(v.Type), v.Addr)
		items = append(items, BusyItem{Kind: "serve", ID: v.ID, Label: label})
	}
	return items
}

// busyTunnel lists the tunnel while it is on, because a paired phone loses its connection on a
// quit or an update.
func (c *Core) busyTunnel() []BusyItem {
	if c.tunnel.Status().State == tunnel.StateOff {
		return nil
	}
	return []BusyItem{{Kind: "tunnel", ID: "tunnel", Label: i18n.T("The remote tunnel"), Detail: i18n.T("A paired phone loses its connection")}}
}

// Subscribe calls fn with each of the core's events, in order, until stop is called. fn gets every
// event published after Subscribe returns, so a caller can subscribe and then cause an event
// without missing it. If fn falls behind and misses some events, it then gets bus.Resync, which
// means it should read again what it shows. fn runs on the subscription's goroutine.
func (c *Core) Subscribe(fn func(bus.Event)) (stop func()) {
	ctx, cancel := context.WithCancel(c.ctx)
	done := make(chan struct{})
	sub := c.bus.Subscribe()
	go func() {
		defer close(done)
		for {
			relay(ctx, sub, fn)
			sub.Close()
			if ctx.Err() != nil {
				return
			}
			// The subscription fell behind. The new one is made before Resync is sent, so fn
			// misses nothing that is published after it reads again.
			sub = c.bus.Subscribe()
			fn(bus.Event{Name: bus.Resync})
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// relay passes sub's events to fn until ctx ends or sub falls behind (its channel is closed).
func relay(ctx context.Context, sub *bus.Sub, fn func(bus.Event)) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.C:
			if !ok {
				return
			}
			fn(ev)
		}
	}
}
