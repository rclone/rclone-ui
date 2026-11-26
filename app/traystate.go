package app

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/menus"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/i18n"
)

func (u *ui) showInTray(changed corestate.Part) {
	s := u.store.Snapshot()
	if changed&corestate.Running != 0 {
		u.tray.SetRunning(runningItems(s.Mounts, s.Serves, u.runningAction))
	}
	if changed&(corestate.Transfers|corestate.Progress) != 0 {
		u.tray.SetTransfers(trayTransfersLabel(s.Live))
	}
}

func (u *ui) languageChanged() {
	s := u.store.Snapshot()
	u.tray.SetTransfers(trayTransfersLabel(s.Live))
	u.tray.SetRunning(runningItems(s.Mounts, s.Serves, u.runningAction))
	// AppKit builds the menu bar on the main thread.
	application.InvokeAsync(func() { menus.Set(u.app) })
	u.launcher.LanguageChanged()
}

func trayTransfersLabel(items map[string]bus.TransferProgress) string {
	ps := make([]*bus.TransferProgress, 0, len(items))
	for _, p := range items {
		if !p.Watcher {
			ps = append(ps, &p)
		}
	}
	p := corestate.SumProgress(ps)
	switch {
	case p.Running == 0:
		return ""
	case p.Pct < 0:
		// i18n: The tray menu's History item while transfers run, with their number.
		return i18n.T("History (%d running)", p.Running)
	}
	// i18n: The tray menu's History item while transfers run: their number, and how far along they are.
	return i18n.T("History (%d running · %d%%)", p.Running, p.Pct)
}
