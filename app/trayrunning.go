package app

import (
	"context"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/tray"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/serves"
)

// This file builds the tray's Mounts and Serves submenus, which list what the core is running
// (see showInTray). The UI owns these menus rather than a page, because the tray must stay up to
// date when no window is open.

type runningAction func(ctx context.Context, c runningClients) error

// runningItems builds the Mounts and Serves submenus, when any are running. Each item's action
// captures its row. do runs the action under a name that is used in the log.
func runningItems(ms []mounts.MountRow, ss []serves.ServeRow, do func(name string, a runningAction)) []tray.Item {
	var items []tray.Item
	if len(ms) > 0 {
		var sub []tray.Item
		for _, m := range ms {
			label := m.Source + " → " + m.MountPoint
			running := m.State == string(children.StatusRunning)
			if !running {
				// i18n: A mount or a serve in the tray menu that is still starting, as in "gdrive: → M: (starting)".
				label = i18n.T("%s (starting)", label)
			}
			id, point := m.ID, m.MountPoint
			sub = append(sub, tray.Item{Label: label, Children: []tray.Item{
				{Label: i18n.T("Open"), Disabled: !running, OnClick: func() {
					do("open "+id, func(_ context.Context, c runningClients) error { return c.reveal(point) })
				}},
				{Label: i18n.T("Unmount"), OnClick: func() {
					do("unmount "+id, func(ctx context.Context, c runningClients) error { return c.mounts.Stop(ctx, id) })
				}},
			}})
		}
		if len(ms) > 1 {
			sub = append(sub, tray.Item{Separator: true}, tray.Item{Label: i18n.T("Unmount All"), OnClick: func() {
				do("unmount all", func(ctx context.Context, c runningClients) error { return c.mounts.StopAll(ctx) })
			}})
		}
		// i18n: The tray menu's submenu of running mounts, with their number.
		items = append(items, tray.Item{Label: i18n.T("Mounts (%d)", len(ms)), Children: sub})
	}
	if len(ss) > 0 {
		var sub []tray.Item
		for _, v := range ss {
			label := strings.ToUpper(v.Type) + " " + v.Addr
			if v.State != string(children.StatusRunning) {
				label = i18n.T("%s (starting)", label)
			}
			id, addr := v.ID, v.Addr
			sub = append(sub, tray.Item{Label: label, Children: []tray.Item{
				{Label: i18n.T("Copy Address"), OnClick: func() {
					do("copy "+id, func(_ context.Context, c runningClients) error { c.copy(addr); return nil })
				}},
				{Label: i18n.T("Stop"), OnClick: func() {
					do("stop "+id, func(ctx context.Context, c runningClients) error { return c.serves.Stop(ctx, id) })
				}},
			}})
		}
		if len(ss) > 1 {
			sub = append(sub, tray.Item{Separator: true}, tray.Item{Label: i18n.T("Stop All"), OnClick: func() {
				do("stop all", func(ctx context.Context, c runningClients) error { return c.serves.StopAll(ctx) })
			}})
		}
		// i18n: The tray menu's submenu of running serves, with their number.
		items = append(items, tray.Item{Label: i18n.T("Serves (%d)", len(ss)), Children: sub})
	}
	return items
}

type runningClients struct {
	mounts engine.Stopper
	serves engine.Stopper
	reveal func(path string) error
	copy   func(text string)
}

// runningAction runs a running item's action in the background, with a one-minute timeout, and
// shows any error.
func (u *ui) runningAction(name string, a runningAction) {
	go func() {
		err := func() error {
			if u.theCore() == nil {
				return errs.New("the core is not ready")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			return a(ctx, runningClients{
				mounts: u.apis.Mounts,
				serves: u.apis.Serves,
				reveal: func(path string) error { return u.reveal(path, false) },
				copy: func(text string) {
					u.app.Clipboard.SetText(text)
					u.notifier.send(i18n.T("Address Copied"), i18n.T("%s copied to clipboard", text))
				},
			})
		}()
		if err != nil {
			u.log.Error("tray action", "item", name, "error", err)
			interaction.Message(interaction.Error, "Rclone UI", rclone.ErrorOf(err).Localized().Message)
		}
	}()
}
