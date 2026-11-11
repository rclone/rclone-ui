package app

import (
	"context"
	"runtime"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/launcher"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/settings"
)

// uiSettings is the part of the core's settings that the UI role applies: the launcher's
// shortcut, the tray icon, the startup window and the update channel. It is reloaded on every
// settings.changed event.
type uiSettings struct {
	// load allows only one read and apply at a time. Otherwise two settings.changed events in a
	// row would race, and the older read could be applied last, bringing back the launcher's old
	// shortcut.
	load sync.Mutex

	mu     sync.Mutex
	loaded bool
	cur    settings.Settings

	// language is the language that the tray, the menu bar and the launcher were last drawn in.
	// It is read and written under load.
	language string
}

// settings returns the settings last read from the core, or the defaults before the first read.
func (u *ui) settings() settings.Settings {
	u.applied.mu.Lock()
	defer u.applied.mu.Unlock()
	if !u.applied.loaded {
		return settings.Defaults()
	}
	return u.applied.cur
}

// loadSettings reads the settings from the core and applies what changed. Reads run one at a
// time, each after the previous one was applied, so the last one to run has the newest settings.
func (u *ui) loadSettings(ctx context.Context) {
	u.applied.load.Lock()
	defer u.applied.load.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	next, err := u.apis.Settings.Get(ctx)
	if err != nil {
		u.log.Warn("could not read the settings", "error", err)
		return
	}
	u.applied.mu.Lock()
	prev, first := u.applied.cur, !u.applied.loaded
	u.applied.cur, u.applied.loaded = next, true
	u.applied.mu.Unlock()

	shortcut := next.General.LauncherShortcut
	if shortcut == "" {
		shortcut = launcher.DefaultShortcut
	}
	if first || prev.General.LauncherShortcut != next.General.LauncherShortcut {
		if err := u.launcher.SetShortcut(shortcut); err != nil {
			u.log.Error("could not register the launcher shortcut", "shortcut", shortcut, "error", err)
		}
	}
	if first || prev.Appearance.TrayIcon != next.Appearance.TrayIcon {
		u.tray.SetAppearance(trayAppearance(next.Appearance.TrayIcon))
	}
	// The core has already switched the language (core/settings), either as it started or before
	// it reported that the settings changed. The tray and the menu bar may have been drawn in the
	// system's language before that, so what the Go side shows is drawn again here.
	if lang := i18n.Language(); lang != u.applied.language {
		u.applied.language = lang
		u.languageChanged()
	}
	if next.General.HideStartup {
		u.noStartup.Store(true)
	}
	// Starts, stops or restarts the agents' server when its settings changed.
	u.agents.Apply(next.Agents)
	// The app starts without a Dock icon (ActivationPolicyAccessory), so the first load only acts
	// when the setting asks for the icon.
	if first && next.General.ShowInDock || !first && prev.General.ShowInDock != next.General.ShowInDock {
		showInDock(next.General.ShowInDock)
	}
}

// trayAppearance converts a tray icon setting to the name the tray package uses. An unset value
// gives the OS's default.
func trayAppearance(icon settings.TrayIcon) string {
	switch icon {
	case settings.TrayIconSystem:
		return "system"
	case settings.TrayIconColor:
		return "color"
	case settings.TrayIconDark:
		return "dark"
	case settings.TrayIconLight:
		return "light"
	}
	if runtime.GOOS == "linux" {
		return "color"
	}
	return "system"
}

// skipVersion records a release that the user chose not to install, in the
// updates.skipped_version setting.
func (u *ui) skipVersion(ctx context.Context, v string) {
	if _, err := u.apis.Settings.Update(ctx, settings.Patch{SkippedVersion: &v}); err != nil {
		u.log.Warn("could not record the skipped version", "version", v, "error", err)
	}
}

// hideStartupFromNow turns the "Show Startup screen" setting off.
func (u *ui) hideStartupFromNow(ctx context.Context) {
	hide := true
	if _, err := u.apis.Settings.Update(ctx, settings.Patch{HideStartup: &hide}); err != nil {
		u.log.Warn("could not turn the startup window off", "error", err)
	}
}

// checkProxy tests the proxy at startup. A proxy that can't connect is reported once, before
// every remote fails through it. Choosing Exit quits the app.
func (u *ui) checkProxy(ctx context.Context) {
	proxy := u.settings().Proxy.URL
	if proxy == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := u.apis.Settings.TestProxy(ctx, proxy)
	if err == nil {
		return
	}
	u.log.Warn("the proxy did not connect", "error", err)
	// i18n: The title of the dialog that says the proxy failed to connect at start.
	title := i18n.T("Error")
	msg := i18n.T("You have a proxy set, but it failed to connect. Do you want to continue anyway?")
	// i18n: The button that quits the app, in the dialog that says the proxy failed to connect.
	if !interaction.Ask(interaction.Warning, title, msg, i18n.T("Continue"), i18n.T("Exit")) {
		u.quit(true)
	}
}
