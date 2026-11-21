package app

import (
	"context"
	"time"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/core/config"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/rclone"
)

// unlockConfig asks for the config's password when the core started with an encrypted config
// file and has no saved password or password command for it. If the user cancels, the config
// stays locked. It can be unlocked later with the Remotes window's config file button.
func (u *ui) unlockConfig(ctx context.Context) {
	api := u.apis.Config
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	c, err := api.Get(ctx)
	if err != nil {
		u.log.Warn("could not read the config", "error", err)
		return
	}
	if c.Status != config.StatusNeedsPassword {
		return
	}
	// Windows' prompt shows one line of about 45 characters, so the message is short, and a retry
	// shows only why the password failed.
	message := i18n.T("Enter the password of your rclone config.")
	// i18n: The title of the prompt for the password that encrypts the rclone config file.
	title := i18n.T("Config Password")
	for {
		password, ok, err := interaction.Prompt(title, message, "", true)
		if err != nil || !ok || password == "" {
			return
		}
		if _, err := api.Unlock(ctx, password, false); err != nil {
			message = rclone.ErrorOf(err).Localized().Message
			continue
		}
		// i18n: Asked after the config was unlocked. The buttons are "Save" and "Don't save".
		save := i18n.T("Save the password in the system keychain?")
		if interaction.Ask(interaction.Question, title, save, i18n.T("Save"), i18n.T("Don't save")) {
			if _, err := api.Unlock(ctx, password, true); err != nil {
				u.log.Warn("could not save the config password", "error", err)
			}
		}
		return
	}
}
