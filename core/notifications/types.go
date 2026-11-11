package notifications

import "github.com/rclone/rclone-ui/core/i18n"

// NotificationEvent is the id of an event in the catalog. Each target stores the ids it wants,
// and generic webhooks receive them verbatim, so never rename one after a release.
type NotificationEvent string

const (
	NotificationEventJobStarted   NotificationEvent = "job.started"
	NotificationEventJobCompleted NotificationEvent = "job.completed"
	NotificationEventJobFailed    NotificationEvent = "job.failed"
	NotificationEventMountFailed  NotificationEvent = "mount.failed"
	NotificationEventServeFailed  NotificationEvent = "serve.failed"
	// NotificationEventWatcherFailed is sent when a watcher's sync fails, once per streak of
	// failures.
	NotificationEventWatcherFailed NotificationEvent = "watcher.failed"
	// NotificationEventAppCrashed is sent at startup when the app's previous run didn't stop
	// cleanly.
	NotificationEventAppCrashed NotificationEvent = "app.crashed"
	// NotificationEventUpdateAvailable is sent when the ui's updater finds a new release.
	NotificationEventUpdateAvailable NotificationEvent = "app.update-available"
)

// NotificationSeverity sets the colour of a Discord embed, and is sent to generic webhooks.
type NotificationSeverity string

const (
	NotificationSeverityInfo    NotificationSeverity = "info"
	NotificationSeveritySuccess NotificationSeverity = "success"
	NotificationSeverityError   NotificationSeverity = "error"
)

// NotificationCategory groups the events in the target form.
type NotificationCategory string

const (
	NotificationCategoryTransfers NotificationCategory = "transfers"
	NotificationCategoryMounts    NotificationCategory = "mounts"
	NotificationCategorySystem    NotificationCategory = "system"
)

// NotificationProvider is the kind of service a target sends to. The target's url is a webhook
// URL, a Telegram Bot API URL with its chat id, or, for email, a comma-separated list of
// recipients.
type NotificationProvider string

const (
	NotificationProviderWebhook  NotificationProvider = "webhook"
	NotificationProviderSlack    NotificationProvider = "slack"
	NotificationProviderDiscord  NotificationProvider = "discord"
	NotificationProviderTelegram NotificationProvider = "telegram"
	NotificationProviderEmail    NotificationProvider = "email"
)

type NotificationEventMeta struct {
	ID          NotificationEvent    `json:"id"`
	Label       string               `json:"label"`
	Description string               `json:"description"`
	Category    NotificationCategory `json:"category"`
	Severity    NotificationSeverity `json:"severity"`
}

type NotificationCategoryMeta struct {
	ID    NotificationCategory `json:"id"`
	Label string               `json:"label"`
}

// NotificationCatalog lists the categories and events that the target form offers, in order.
type NotificationCatalog struct {
	Categories []NotificationCategoryMeta `json:"categories"`
	Events     []NotificationEventMeta    `json:"events"`
}

// NotificationTarget is a saved target, as shown in the Notifications window.
type NotificationTarget struct {
	ID        string               `json:"id"`
	Provider  NotificationProvider `json:"provider"`
	Name      string               `json:"name"`
	URL       string               `json:"url"`
	IsEnabled bool                 `json:"isEnabled"`
	Events    []NotificationEvent  `json:"events"`
	CreatedAt int64                `json:"createdAt"`
	// LastSentAt and LastError describe the last delivery, including a test of a saved target.
	// LastError is English inside the core, and the API gives it in the app's language.
	LastSentAt *int64 `json:"lastSentAt,omitempty"`
	LastError  string `json:"lastError,omitempty"`

	lastError i18n.Text // LastError as a translatable text, read from its saved form
}

// local returns t as a page shows it, with its last error in the app's language.
func (t NotificationTarget) local() NotificationTarget {
	t.LastError = t.lastError.Local()
	return t
}

// TargetInput is the target form. An update keeps the saved provider and refuses a different
// one. The form includes the provider either way, because Problems needs it.
type TargetInput struct {
	Provider  NotificationProvider `json:"provider"`
	Name      string               `json:"name"`
	URL       string               `json:"url"`
	Events    []NotificationEvent  `json:"events"`
	IsEnabled bool                 `json:"isEnabled"`
}

// TestInput asks for a test send. With an ID, the test goes to that saved target using its saved
// values, and the outcome is recorded on it. Without one, it goes to the unsaved form's provider
// and URL.
type TestInput struct {
	ID       string               `json:"id,omitempty"`
	Provider NotificationProvider `json:"provider,omitempty"`
	Name     string               `json:"name,omitempty"`
	URL      string               `json:"url,omitempty"`
}

// Outcome is the result of a test send.
type Outcome struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

// SMTPEncryption is how the connection to the mail server is encrypted: STARTTLS, TLS from the
// first byte, or none.
type SMTPEncryption string

const (
	SMTPEncryptionStartTLS SMTPEncryption = "starttls"
	SMTPEncryptionTLS      SMTPEncryption = "tls"
	SMTPEncryptionNone     SMTPEncryption = "none"
)

// SMTPView is the saved mail server as a page may see it. It has no password, only whether one
// is saved. An empty host means the mail server is not set up.
type SMTPView struct {
	Host        string         `json:"host"`
	Port        int            `json:"port"`
	Encryption  SMTPEncryption `json:"encryption"`
	Username    string         `json:"username"`
	HasPassword bool           `json:"hasPassword"`
	FromAddress string         `json:"fromAddress"`
	FromName    string         `json:"fromName"`
}

// SMTPInput is the form that the Notifications window's mail server drawer saves. An empty
// password keeps the saved one, an empty username removes the saved password, and an empty host
// clears the settings.
type SMTPInput struct {
	Host        string         `json:"host"`
	Port        int            `json:"port"`
	Encryption  SMTPEncryption `json:"encryption"`
	Username    string         `json:"username"`
	Password    string         `json:"password"`
	FromAddress string         `json:"fromAddress"`
	FromName    string         `json:"fromName"`
}
