package app

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/menus"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/i18n"
)

// showInTray shows the core's state from the store in the tray: the Mounts and Serves submenus,
// and the History item and the dot on the tray icon, which both show only while the core runs
// transfers. The store calls it with the parts that changed. Each call reads the latest snapshot,
// so the tray ends up showing the latest state, and nothing once the core has stopped.
func (u *ui) showInTray(changed corestate.Part) {
	s := u.store.Snapshot()
	if changed&corestate.Running != 0 {
		u.tray.SetRunning(runningItems(s.Mounts, s.Serves, u.runningAction))
	}
	if changed&(corestate.Transfers|corestate.Progress) != 0 {
		u.tray.SetTransfers(trayTransfersLabel(s.Live))
	}
}

// languageChanged draws again, in the new language, everything that the Go side keeps on screen:
// the tray's menu, the menu bar and the launcher. The windows follow the setting themselves
// (lib/i18n.ts). Dialogs and toasts are translated as they show.
func (u *ui) languageChanged() {
	s := u.store.Snapshot()
	u.tray.SetTransfers(trayTransfersLabel(s.Live))
	// SetRunning builds the menu again, with its own labels in the new language.
	u.tray.SetRunning(runningItems(s.Mounts, s.Serves, u.runningAction))
	// AppKit builds the menu bar on the main thread.
	application.InvokeAsync(func() { menus.Set(u.app) })
	u.launcher.LanguageChanged()
}

// trayTransfersLabel returns the label of the History item for the running transfers, keyed by
// ID, such as "History (2 running · 42%)". It returns "" when none is running, which hides the
// item and the icon's dot. A watcher's runs are left out, because they run every minute and would
// make History and the dot come and go.
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
