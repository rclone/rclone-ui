package settings

import (
	"slices"

	"github.com/google/uuid"
)

// Settings is the whole settings document. The database stores it as JSON, and the pages receive
// the same JSON.
type Settings struct {
	General    General    `json:"general"`
	Appearance Appearance `json:"appearance"`
	Proxy      Proxy      `json:"proxy"`
	Transfers  Transfers  `json:"transfers"`
	Updates    Updates    `json:"updates"`
	Agents     Agents     `json:"agents"`
	Telemetry  Telemetry  `json:"telemetry"`
}

// Telemetry holds the user's choice about the anonymous usage data and crash reports that the app
// sends (core/telemetry).
type Telemetry struct {
	// Enabled is whether the user shares them. It starts on, except on Linux, where it starts
	// off and the user turns it on.
	Enabled bool `json:"enabled"`
	// ID is the random id that the data is sent under. It names no person and no computer. The
	// core makes one while Enabled is on, and forgets it when the user turns it off, so turning
	// it on again starts a new one.
	ID string `json:"id"`
}

const DefaultAgentPort = 5590

// Agents holds the settings of the MCP server that lets AI agents use the app (core/agents). It is
// off until the user turns it on. It listens on this computer only, and a client must send the
// token.
type Agents struct {
	Enabled bool `json:"enabled"`
	// Port is the port on 127.0.0.1 that the server listens on.
	Port int `json:"port"`
	// Token is the bearer token that a client sends. The core makes one when the server is first
	// turned on, and a new one on request (Patch.NewAgentToken).
	Token string `json:"token"`
}

type Transfers struct {
	// BwLimit limits the bandwidth of every transfer, mount and serve together, as rclone's
	// --bwlimit does: "10M", or an upload and a download speed, "10M:2M". "" means no limit. A
	// change applies at once.
	BwLimit string `json:"bwLimit"`
}

type General struct {
	HideStartup bool `json:"hideStartup"`
	// LauncherShortcut is the global shortcut that opens the launcher, such as
	// "CmdOrCtrl+Shift+/". An empty string means the default.
	LauncherShortcut string `json:"launcherShortcut"`
	// ResumeAfterLogout records what is running when the OS ends the session (a logout, a
	// restart or a shutdown), so it starts again with the app. When it is off, quitting because
	// of the OS keeps nothing, like any other quit. It works on macOS and Windows only, because
	// on Linux a logout ends the app.
	ResumeAfterLogout bool `json:"resumeAfterLogout"`
	// ShowInDock shows the app's icon in the Dock and in the app switcher on macOS. By default
	// the app lives in the menu bar only. Other systems ignore it.
	ShowInDock bool `json:"showInDock"`
	// Language is the app's language, as one of core/i18n's languages ("es", "zh-CN"). An empty
	// string means the system's language.
	Language string `json:"language"`
}

type TrayIcon string

const (
	// TrayIconDefault uses the OS default, which is System everywhere except Linux, where it
	// is Color.
	TrayIconDefault TrayIcon = "TRAY_ICON_UNSPECIFIED"
	TrayIconSystem  TrayIcon = "TRAY_ICON_SYSTEM"
	TrayIconColor   TrayIcon = "TRAY_ICON_COLOR"
	TrayIconDark    TrayIcon = "TRAY_ICON_DARK"
	TrayIconLight   TrayIcon = "TRAY_ICON_LIGHT"
)

type Appearance struct {
	TrayIcon TrayIcon `json:"trayIcon"`
}

// Proxy is the proxy used by rclone and by the app's own requests.
type Proxy struct {
	// URL is empty for no proxy.
	URL string `json:"url"`
	// IgnoredHosts are reached without the proxy (NO_PROXY).
	IgnoredHosts []string `json:"ignoredHosts"`
}

type Updates struct {
	// Channel is "stable" or "beta".
	Channel string `json:"channel"`
	// SkippedVersion is the release the user chose to skip.
	SkippedVersion string `json:"skippedVersion"`
}

// Patch is a change to the settings. Each field that is set replaces its setting, and a nil field
// keeps its value. The Proxy is replaced as a whole, because its URL and its ignored hosts go
// together. A page sends only what it changes, so a change made in another window at the same
// time is kept.
type Patch struct {
	HideStartup       *bool     `json:"hideStartup,omitempty"`
	LauncherShortcut  *string   `json:"launcherShortcut,omitempty"`
	ResumeAfterLogout *bool     `json:"resumeAfterLogout,omitempty"`
	ShowInDock        *bool     `json:"showInDock,omitempty"`
	Language          *string   `json:"language,omitempty"`
	TrayIcon          *TrayIcon `json:"trayIcon,omitempty"`
	Proxy             *Proxy    `json:"proxy,omitempty"`
	BwLimit           *string   `json:"bwLimit,omitempty"`
	Channel           *string   `json:"channel,omitempty"`
	SkippedVersion    *string   `json:"skippedVersion,omitempty"`
	AgentsEnabled     *bool     `json:"agentsEnabled,omitempty"`
	AgentPort         *int      `json:"agentPort,omitempty"`
	// NewAgentToken replaces the agents' token, so that clients set up with the old one stop
	// working.
	NewAgentToken bool `json:"newAgentToken,omitempty"`
	// TelemetryEnabled is the user's choice about sharing usage data and crash reports.
	TelemetryEnabled *bool `json:"telemetryEnabled,omitempty"`
}

func (p Patch) apply(s *Settings) {
	set(&s.General.HideStartup, p.HideStartup)
	set(&s.General.LauncherShortcut, p.LauncherShortcut)
	set(&s.General.ResumeAfterLogout, p.ResumeAfterLogout)
	set(&s.General.ShowInDock, p.ShowInDock)
	set(&s.General.Language, p.Language)
	set(&s.Appearance.TrayIcon, p.TrayIcon)
	set(&s.Transfers.BwLimit, p.BwLimit)
	set(&s.Updates.Channel, p.Channel)
	set(&s.Updates.SkippedVersion, p.SkippedVersion)
	set(&s.Agents.Enabled, p.AgentsEnabled)
	set(&s.Agents.Port, p.AgentPort)
	if p.NewAgentToken {
		s.Agents.Token = ""
	}
	if s.Agents.Enabled && s.Agents.Token == "" {
		s.Agents.Token = newToken()
	}
	set(&s.Telemetry.Enabled, p.TelemetryEnabled)
	switch {
	case !s.Telemetry.Enabled:
		s.Telemetry.ID = ""
	case s.Telemetry.ID == "":
		s.Telemetry.ID = uuid.NewString()
	}
	if p.Proxy != nil {
		s.Proxy = Proxy{URL: p.Proxy.URL, IgnoredHosts: slices.Clone(p.Proxy.IgnoredHosts)}
		if s.Proxy.IgnoredHosts == nil {
			s.Proxy.IgnoredHosts = []string{}
		}
	}
}

func set[T any](dst *T, v *T) {
	if v != nil {
		*dst = *v
	}
}

type UpdateResult struct {
	Settings Settings `json:"settings"`
	// RestartRequired is true when part of the change (the proxy) only applies after the app
	// starts again.
	RestartRequired bool `json:"restartRequired"`
}
