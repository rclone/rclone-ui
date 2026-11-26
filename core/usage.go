package core

import (
	"context"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/httpx"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/settings"
	"github.com/rclone/rclone-ui/core/telemetry"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/version"
)

func (c *Core) newTelemetry() *telemetry.Service {
	return telemetry.New(telemetry.Options{
		Transport:  httpx.New(0).Transport,
		DoNotTrack: doNotTrack(os.Getenv("DO_NOT_TRACK")),
		Props:      telemetryProps,
		Names:      c.store.GetSectionList,
		Started:    c.describeRun,
		Log:        logs.Logger(logs.CompApp, "telemetry"),
	})
}

func doNotTrack(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false":
		return false
	}
	return true
}

func telemetryProps() map[string]any {
	return map[string]any{
		"app_version":    version.App,
		"rclone_version": version.Rclone(),
		"arch":           runtime.GOARCH,
		"language":       i18n.Language(),
		"install":        installKind(),
	}
}

func installKind() string {
	switch {
	case os.Getenv("FLATPAK_ID") != "":
		return "flatpak"
	case os.Getenv("APPIMAGE") != "":
		return "appimage"
	case os.Getenv("SNAP") != "":
		return "snap"
	}
	if _, portable := datadir.Portable(); portable {
		return "portable"
	}
	return "standard"
}

func (c *Core) startTelemetry(ctx context.Context) {
	c.settings.OnChange(func(st settings.Settings) { c.telemetry.Apply(st.Telemetry) })
	st, err := c.settings.Get(ctx)
	if info := c.telemetry.Info(); err == nil && info.Built && !info.DoNotTrack && st.Telemetry.Enabled && st.Telemetry.ID == "" {
		st, _, err = c.settings.Update(ctx, settings.Patch{})
	}
	if err == nil {
		c.telemetry.Apply(st.Telemetry)
	}
	if c.logs != nil && c.logs.Path() != "" {
		crashLog := filepath.Join(filepath.Dir(c.logs.Path()), "crash.log")
		c.GoOnce("telemetry.crash", func(context.Context) { c.telemetry.CrashLog(crashLog) })
	}
	c.Subscribe(c.usageOf)
}

func (c *Core) describeRun() {
	var once sync.Once
	send := func() { once.Do(func() { c.GoOnce("telemetry.started", c.appStarted) }) }
	c.configs.OnUnlocked(send)
	if !c.configs.Locked() {
		send()
	}
}

func (c *Core) appStarted(ctx context.Context) {
	names := c.store.GetSectionList()
	types := map[string]bool{}
	for _, name := range names {
		if typ, ok := c.store.GetValue(name, "type"); ok && typ != "" {
			types[typ] = true
		}
	}
	props := map[string]any{
		"remotes":        len(names),
		"backends":       slices.Sorted(maps.Keys(types)),
		"crashed_before": c.crashed,
	}
	if list, err := c.schedules.List(ctx); err == nil {
		props["schedules"] = len(list)
	}
	if list, err := c.watchers.List(ctx); err == nil {
		props["watchers"] = len(list)
	}
	if list, err := c.templates.List(ctx); err == nil {
		props["templates"] = len(list)
	}
	if list, err := c.mounts.Automounts(ctx); err == nil {
		props["automounts"] = len(list)
	}
	if st, err := c.settings.Get(ctx); err == nil {
		props["agents"] = st.Agents.Enabled
		props["channel"] = st.Updates.Channel
		props["startup_screen"] = !st.General.HideStartup
	}
	c.telemetry.Capture("app_started", props)
}

func (c *Core) backendOf(path string) string {
	if path == "" {
		return ""
	}
	at, err := location.Split(path)
	switch {
	case err != nil:
		return "unknown"
	case at.Local:
		return "local"
	case strings.HasPrefix(at.Name, ":"):
		return strings.TrimPrefix(at.Name, ":") // a backend named in the path itself, as in ":s3:"
	}
	if typ, ok := c.store.GetValue(at.Name, "type"); ok && typ != "" {
		return typ
	}
	return "unknown"
}

func (c *Core) transferEnded(t transfers.Transfer) {
	if t.Origin.Kind == transfers.OriginWatcher && transfers.ChangedNothing(t.Stats) {
		return
	}
	props := map[string]any{
		"operation":           string(t.Operation),
		"state":               string(t.State),
		"origin":              string(t.Origin.Kind),
		"dry_run":             t.IsDryRun,
		"sources":             len(t.Sources),
		"destination_backend": c.backendOf(t.Destination),
	}
	if len(t.Sources) > 0 {
		props["source_backend"] = c.backendOf(t.Sources[0])
	}
	if s := t.Stats; s != nil {
		props["bytes"] = s.Bytes
		props["files"] = s.Transfers
		props["errors"] = s.Errors
		props["deletes"] = s.Deletes
		props["duration_s"] = s.DurationMs / 1000
	}
	c.telemetry.Capture("transfer_ended", props)
}

func (c *Core) usageOf(ev bus.Event) {
	switch d := ev.Data.(type) {
	case bus.MountsChangedData:
		if d.State != string(children.StatusRunning) {
			return
		}
		for _, m := range c.mounts.List() {
			if m.ID == d.ID {
				c.telemetry.Capture("mount_started", map[string]any{
					"backend": c.backendOf(m.Source), "automount": m.Automount,
				})
			}
		}
	case bus.ServesChangedData:
		if d.State != string(children.StatusRunning) {
			return
		}
		for _, v := range c.serves.List() {
			if v.ID == d.ID {
				c.telemetry.Capture("serve_started", map[string]any{
					"protocol": v.Type, "backend": c.backendOf(v.Source),
				})
			}
		}
	}
}
