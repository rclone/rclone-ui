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

const notifyTimeout = 15 * time.Second

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
	c.configs.Attach(store)
	store.OnState(func(st rclone.State) {
		c.configs.StateChanged(st)
		c.bus.Publish(bus.ConfigChanged, nil)
	})
	st := store.State()
	logs.Logger(logs.CompApp, "rclone").InfoContext(ctx, "config", "path", st.Path, "status", string(st.Status))
	return nil
}

func (c *Core) build() error {
	c.telemetry = c.newTelemetry()
	c.templates = templates.New(c.db, c.bus, c.exe)
	c.favorites = favorites.New(c.db, c.bus)
	c.launcher = launcher.New(c.db)
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

	c.transfers = transfers.New(transfers.Options{
		DB: c.db, Bus: c.bus, Notifier: c.notifications, Run: c,
		Ended: func(t transfers.Transfer) {
			lister.TransferEnded(t.Operation, t.Sources, t.Destination)
			c.transferEnded(t)
		},
	})
	c.watchers = watchers.New(watchers.Options{
		DB: c.db, Bus: c.bus, Transfers: c.transfers, Notifier: c.notifications, Run: c,
	})
	c.schedules = schedules.New(schedules.Options{
		DB: c.db, Bus: c.bus, Transfers: c.transfers, Templates: c.templates, Watchers: c.watchers,
		Notifier: c.notifications, Run: c, Crashed: c.crashed, Locked: c.configs.Locked,
	})
	c.files = files.New(c.bus, lister, c.transfers)
	c.media = media.NewSigner()

	c.remotes = remotes.New(remotes.Options{
		DB: c.db, Store: c.store, Bus: c.bus, Run: c, Config: c.configs, Invalidator: lister,
		Followers: []remotes.Follower{c.favorites, c.templates, c.mounts, c.watchers, c.schedules},
		Edited:    c.childRemotesChanged,
	})
	c.built = true
	return nil
}

func (c *Core) start(ctx context.Context) error {
	if err := c.launcher.Prune(ctx); err != nil {
		logs.Logger(logs.CompApp, "launcher").ErrorContext(ctx, "pruning the launcher's usage history", "error", err)
	}
	if err := c.media.Listen(); err != nil {
		return fmt.Errorf("browse: serving the media URLs: %w", err)
	}
	c.notifications.Start()
	if c.crashed {
		c.notifications.Notify(ctx, notifications.NotificationEventAppCrashed, notifications.Crashed{Crashes: 1})
	}
	c.remotes.Start(ctx)
	c.Go("config.watch", c.store.Watch)
	c.settings.OnBwLimit(c.setBwLimit)
	c.startTelemetry(ctx)
	if err := c.startChildren(ctx); err != nil {
		return fmt.Errorf("children: %w", err)
	}
	var last int64
	if prev := c.logs.Previous(); !prev.IsZero() {
		last = prev.UnixMilli()
	}
	if err := c.transfers.Recover(ctx, last); err != nil {
		return fmt.Errorf("transfers: %w", err)
	}
	return nil
}

func (c *Core) background() {
	c.GoOnce("mounts.boot", c.mounts.Boot)
	c.GoOnce("serves.boot", c.serves.Boot)
	c.GoOnce("tunnel.boot", c.tunnel.Boot)
	c.Go("watchers", c.watchers.Run)
	c.Go("schedules", c.schedules.Run)
}

func (c *Core) setBwLimit(ctx context.Context, limit string) {
	pair, err := settings.BwLimit(limit)
	if err != nil {
		return
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

func (c *Core) startChildren(ctx context.Context) error {
	log := logs.Logger(logs.CompChildren, logs.SubSupervisor)
	points, err := mounts.AutomountPoints(ctx, c.db, runtime.GOOS)
	if err != nil {
		log.ErrorContext(ctx, "could not read the automounts; only the recorded mount points are checked", "error", err)
	}
	lo := children.ClearLeftovers(ctx, children.LeftoverOptions{RunDir: c.runDir, SocketDir: c.socketDir, Automounts: points})
	return c.children.Begin(lo.Restore)
}

func (c *Core) childRemotesChanged(names []string) {
	uses := func(source string) bool { return rclone.Mentions(source, names) }
	c.mounts.RemotesChanged(uses)
	c.serves.RemotesChanged(uses)
}

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

type BusyItem struct {
	Kind   string
	ID     string
	Label  string
	Detail string
}

type BusyList struct {
	Items   []BusyItem
	Running Running
}

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

type Running struct {
	Transfers, Mounts, Serves int
	Tunnel                    bool
}

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

func (s StopSummary) Done() i18n.Text {
	if p := s.Phrase(); !p.IsZero() {
		// i18n: %s names what was stopped: "2 transfers, a serve and 3 mounts".
		return i18n.M("Stopped %s.", p)
	}
	return i18n.M("Nothing was running.")
}

type Kept struct {
	Watchers  int `json:"watchers"`
	Schedules int `json:"schedules"`
}

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
			sub = c.bus.Subscribe()
			fn(bus.Event{Name: bus.Resync})
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

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
