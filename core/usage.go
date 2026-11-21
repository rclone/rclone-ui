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

// The usage data that the core sends through core/telemetry, while the user shares it. Each event
// here is built from kinds and counts only: an operation's kind, a backend's type, how many, how
// long. A path, a file's name or a remote's name never goes into one.

// newTelemetry creates the sender. It sends nothing until startTelemetry applies the user's
// choice.
func (c *Core) newTelemetry() *telemetry.Service {
	return telemetry.New(telemetry.Options{
		// Through the app's proxy, like the app's other requests.
		Transport:  httpx.New(0).Transport,
		DoNotTrack: doNotTrack(os.Getenv("DO_NOT_TRACK")),
		Props:      telemetryProps,
		Names:      c.store.GetSectionList,
		Started:    c.describeRun,
		Log:        logs.Logger(logs.CompApp, "telemetry"),
	})
}

// doNotTrack reports whether the DO_NOT_TRACK variable asks for no data: any value but none, 0
// and false.
func doNotTrack(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false":
		return false
	}
	return true
}

// telemetryProps returns what every event carries about the app itself.
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

// startTelemetry applies the user's choice now and after each change of the settings, and reports
// the crash that the last run left, if any.
func (c *Core) startTelemetry(ctx context.Context) {
	c.settings.OnChange(func(st settings.Settings) { c.telemetry.Apply(st.Telemetry) })
	st, err := c.settings.Get(ctx)
	// Where sharing is on by default, the settings have no Telemetry.ID until they are saved. An
	// empty Update saves them, which creates the ID. A build that sends nothing needs none.
	if info := c.telemetry.Info(); err == nil && info.Built && !info.DoNotTrack && st.Telemetry.Enabled && st.Telemetry.ID == "" {
		st, _, err = c.settings.Update(ctx, settings.Patch{})
	}
	if err == nil {
		c.telemetry.Apply(st.Telemetry)
	}
	// The app's own log and crash.log are in the same folder (the shell's keepCrashes).
	if c.logs != nil && c.logs.Path() != "" {
		crashLog := filepath.Join(filepath.Dir(c.logs.Path()), "crash.log")
		c.GoOnce("telemetry.crash", func(context.Context) { c.telemetry.CrashLog(crashLog) })
	}
	c.Subscribe(c.usageOf)
}

// describeRun sends the event that describes this run, once the config file can be read. A file
// that still waits for its password has no remotes to count, so the event waits for the unlock.
func (c *Core) describeRun() {
	var once sync.Once
	send := func() { once.Do(func() { c.GoOnce("telemetry.started", c.appStarted) }) }
	c.configs.OnUnlocked(send)
	if !c.configs.Locked() {
		send()
	}
}

// appStarted sends the event that describes this run: how much the user has set up, by count and
// by the types of their remotes.
func (c *Core) appStarted(ctx context.Context) {
	names := c.store.GetSectionList()
	types := map[string]bool{}
	for _, name := range names {
		if typ, ok := c.store.GetValue(name, "type"); ok && typ != "" {
			types[typ] = true
		}
	}
	props := map[string]any{
		"remotes":  len(names),
		"backends": slices.Sorted(maps.Keys(types)),
		// The run before this one didn't stop cleanly.
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

// backendOf returns the type of the backend that a path is on ("s3", "drive"), "local" for this
// computer, and "unknown" for a remote that isn't in the config. The path's own text goes
// nowhere.
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

// transferEnded sends a transfer's end: what kind it was, where it was started from, between
// which backends, how it ended and its totals. A watcher's run that changed nothing is left out,
// because a watcher may run every minute.
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

// usageOf sends the events that follow from the core's own: a mount or a serve that came up.
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
