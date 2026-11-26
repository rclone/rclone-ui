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

type uiSettings struct {
	load sync.Mutex

	mu     sync.Mutex
	loaded bool
	cur    settings.Settings

	language string
}

func (u *ui) settings() settings.Settings {
	u.applied.mu.Lock()
	defer u.applied.mu.Unlock()
	if !u.applied.loaded {
		return settings.Defaults()
	}
	return u.applied.cur
}

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
	if first || prev.General.LauncherStaysOpen != next.General.LauncherStaysOpen {
		u.launcher.SetStaysOpen(next.General.LauncherStaysOpen)
	}
	if first || prev.Appearance.TrayIcon != next.Appearance.TrayIcon {
		u.tray.SetAppearance(trayAppearance(next.Appearance.TrayIcon))
	}
	if lang := i18n.Language(); lang != u.applied.language {
		u.applied.language = lang
		u.languageChanged()
	}
	if next.General.HideStartup {
		u.noStartup.Store(true)
	}
	u.agents.Apply(next.Agents)
	if first && next.General.ShowInDock || !first && prev.General.ShowInDock != next.General.ShowInDock {
		showInDock(next.General.ShowInDock)
	}
}

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

func (u *ui) skipVersion(ctx context.Context, v string) {
	if _, err := u.apis.Settings.Update(ctx, settings.Patch{SkippedVersion: &v}); err != nil {
		u.log.Warn("could not record the skipped version", "version", v, "error", err)
	}
}

func (u *ui) hideStartupFromNow(ctx context.Context) {
	hide := true
	if _, err := u.apis.Settings.Update(ctx, settings.Patch{HideStartup: &hide}); err != nil {
		u.log.Warn("could not turn the startup window off", "error", err)
	}
}

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
