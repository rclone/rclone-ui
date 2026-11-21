package config

import "github.com/rclone/rclone-ui/core/i18n"

// Status is whether a config file can be used.
type Status string

const (
	StatusOK            Status = "ok"
	StatusNeedsPassword Status = "needs_password"
	StatusError         Status = "error"
	StatusMissing       Status = "missing"
)

// ConfigFile is the app's rclone config file. Its Message and SaveError are in English, and the
// API gives them in the app's language (shown).
type ConfigFile struct { //nolint:revive // config.ConfigFile reads as the pages name it
	Path      string `json:"path"`
	Encrypted bool   `json:"encrypted"`
	Status    Status `json:"status"`
	// Message says what's wrong, when Status is an error.
	Message string `json:"message"`
	// PasswordSaved says its password is in the keychain.
	PasswordSaved   bool   `json:"passwordSaved"`
	PasswordCommand string `json:"passwordCommand"`
	// SaveError is why rclone's last save of it failed, or why its password couldn't be saved
	// to the keychain.
	SaveError string `json:"saveError"`

	message, saveError i18n.Text // Message and SaveError, to translate
}

func (c *ConfigFile) setMessage(text i18n.Text) { c.message, c.Message = text, text.String() }

func (c *ConfigFile) setSaveError(text i18n.Text) { c.saveError, c.SaveError = text, text.String() }

// shown returns a copy of c with its Message and SaveError in the app's language, for a page.
func (c *ConfigFile) shown() *ConfigFile {
	if c == nil {
		return nil
	}
	out := *c
	if !c.message.IsZero() {
		out.Message = c.message.Local()
	}
	if !c.saveError.IsZero() {
		out.SaveError = c.saveError.Local()
	}
	return &out
}
