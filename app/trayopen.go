package app

import (
	"context"
	"encoding/json"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/launcher"
	"github.com/rclone/rclone-ui/core/i18n"
)

// openShortcutAck is the acknowledgement that is recorded once the user has read the tip about the
// shortcut. It is stored in the pages' "acknowledgements" pref.
const openShortcutAck = "openShortcut"

func (u *ui) trayOpen(ctx context.Context) {
	if !u.acknowledged(ctx, openShortcutAck) {
		shortcut := u.settings().General.LauncherShortcut
		if shortcut == "" {
			shortcut = launcher.DefaultShortcut
		}
		interaction.Show(interaction.Dialog{
			Kind:    interaction.Info,
			Title:   i18n.T("Did you know?"),
			Message: i18n.T("You can also open the Launcher using the shortcut %s.", shortcutLabel(shortcut, runtime.GOOS)),
			OK:      i18n.T("Good to know"),
		})
		u.acknowledge(ctx, openShortcutAck)
	}
	u.launcher.Show()
}

// shortcutLabel formats a shortcut the way the tip shows it, such as "Command + Shift + /".
func shortcutLabel(shortcut, goos string) string {
	keys := strings.Split(shortcut, "+")
	for i, k := range keys {
		switch strings.ToLower(k) {
		case "cmdorctrl", "commandorcontrol":
			keys[i] = "Control"
			if goos == "darwin" {
				keys[i] = "Command"
			}
		case "cmd", "command", "super", "meta":
			keys[i] = "Command"
		case "ctrl", "control":
			keys[i] = "Control"
		case "alt", "option":
			keys[i] = "Alt"
			if goos == "darwin" {
				keys[i] = "Option"
			}
		}
	}
	return strings.Join(keys, " + ")
}

// acknowledgements returns the pages' list of hints that the user dismissed. It returns false
// when the list can't be read.
func (u *ui) acknowledgements(ctx context.Context) ([]string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	values, err := u.apis.Prefs.Get(ctx, []string{"acknowledgements"})
	if err != nil {
		u.log.Warn("could not read the acknowledgements", "error", err)
		return nil, false
	}
	var list []string
	if raw := values["acknowledgements"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &list)
	}
	return list, true
}

// acknowledged reports whether the hint was dismissed. If the list can't be read, the hint counts
// as dismissed, so that it doesn't come back on every Open.
func (u *ui) acknowledged(ctx context.Context, key string) bool {
	list, ok := u.acknowledgements(ctx)
	return !ok || slices.Contains(list, key)
}

func (u *ui) acknowledge(ctx context.Context, key string) {
	list, ok := u.acknowledgements(ctx)
	if !ok || slices.Contains(list, key) {
		return
	}
	raw, _ := json.Marshal(append(list, key))
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := u.apis.Prefs.Set(ctx, "acknowledgements", string(raw)); err != nil {
		u.log.Warn("could not record an acknowledgement", "key", key, "error", err)
	}
}
