package notifications

import (
	"net/mail"
	"net/url"
	"regexp"
	"strings"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

var (
	// discord.com, the legacy discordapp.com, and the ptb. and canary. clients.
	reDiscordWebhook = regexp.MustCompile(`^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+$`)
	reSlackWebhook   = regexp.MustCompile(`^https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/\w+$`)
	// The stored Telegram URL has the bot token in the path and chat_id in the query.
	reTelegramSendMessage = regexp.MustCompile(`^https://api\.telegram\.org/bot\d+:[\w-]+/sendMessage(\?\S*)?$`)
	reTelegramChatID      = regexp.MustCompile(`^(-?\d+|@\w{5,})$`)
)

func knownProvider(p NotificationProvider) bool {
	switch p {
	case NotificationProviderWebhook, NotificationProviderSlack, NotificationProviderDiscord,
		NotificationProviderTelegram, NotificationProviderEmail:
		return true
	}
	return false
}

// recipients returns the addresses in an email target's url, which is a comma-separated list.
func recipients(value string) []string {
	var out []string
	for a := range strings.SplitSeq(value, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

// validateRecipients refuses an email target's url that has no address, or an entry that isn't
// a single address, as an error on its url field.
func validateRecipients(value string) error {
	addrs := recipients(value)
	if len(addrs) == 0 {
		return errs.Field("url", "Enter one or more email addresses, separated by commas.")
	}
	if a, ok := badAddress(addrs); ok {
		return errs.Field("url", notAnAddress, a)
	}
	return nil
}

// notAnAddress is the message for an entry that isn't one bare email address.
const notAnAddress = "‘%s’ is not an email address."

// badAddress returns the first entry of to that isn't a single address, as the send reads it
// (mailbox).
func badAddress(to []string) (string, bool) {
	for _, a := range to {
		if _, err := mailbox(a); err != nil {
			return a, true
		}
	}
	return "", false
}

// checkRecipients rejects a list that is empty or has an entry that isn't a single address
// (mailbox). The send calls it, so one bad address stops the email to every address of the
// target.
func checkRecipients(to []string) error {
	if len(to) == 0 {
		return errs.New("Enter at least one email address.")
	}
	if a, ok := badAddress(to); ok {
		return errs.Errorf(notAnAddress, strings.TrimSpace(a))
	}
	return nil
}

// validateURL returns why raw doesn't suit the provider, as an error on the url field, or nil
// if it suits it.
func validateURL(provider NotificationProvider, raw string) error {
	trimmed := strings.TrimSpace(raw)
	if provider == NotificationProviderEmail {
		return validateRecipients(trimmed)
	}
	if trimmed == "" {
		return errs.Field("url", "A webhook URL is required")
	}
	switch provider {
	case NotificationProviderDiscord:
		if !reDiscordWebhook.MatchString(trimmed) {
			return errs.Field("url", "This doesn't look like a Discord webhook URL. Expected https://discord.com/api/webhooks/…")
		}
		return nil
	case NotificationProviderSlack:
		if !reSlackWebhook.MatchString(trimmed) {
			return errs.Field("url", "This doesn't look like a Slack webhook URL. Expected https://hooks.slack.com/services/…")
		}
		return nil
	case NotificationProviderTelegram:
		token, chatID := telegramProblems(trimmed)
		if token != nil {
			return token
		}
		return chatID
	}
	// A webhook is an absolute http or https URL with a host.
	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" {
		return errs.Field("url", "This is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errs.Field("url", "The URL must use http:// or https://")
	}
	if u.Host == "" {
		return errs.Field("url", "This is not a valid URL")
	}
	return nil
}

// chatIDProblem is the message for a Telegram chat ID that is not a number or a channel.
const chatIDProblem = "Enter the chat ID as a number, as in 123456789 or -1001234567890, or @channelname for a public channel."

// telegramProblems returns why the bot token and the chat ID of a stored Telegram URL aren't
// valid, each as nil when it is. The form edits the two parts in their own fields, so the token's
// error is on url and the chat ID's on chatId.
func telegramProblems(raw string) (token, chatID error) {
	switch {
	case telegramToken(raw) == "":
		token = errs.Field("url", "A bot token is required")
	case !reTelegramSendMessage.MatchString(raw):
		token = errs.Field("url", "This doesn't look like a bot token. Enter the token that BotFather sent, as in 123456789:AAH…")
	}
	switch id := strings.TrimSpace(telegramChatID(raw)); {
	case id == "":
		chatID = errs.Field("chatId", "A chat ID is required")
	case !reTelegramChatID.MatchString(id):
		chatID = errs.Field("chatId", chatIDProblem)
	}
	return token, chatID
}

// telegramToken returns the bot token in a stored Telegram URL's path, or "" when there is none.
// The URL isn't parsed, so a token is found in a URL that is invalid elsewhere.
func telegramToken(raw string) string {
	_, token, _ := strings.Cut(raw, "/bot")
	token, _, _ = strings.Cut(token, "/")
	return token
}

func telegramChatID(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Query().Get("chat_id")
}

// Problems holds a form's field errors, as a map from field to message.
type Problems map[string]string

// Problems returns the form's field errors in the app's language, for the page to show as the
// user types (API.Check). It is empty when the form can be saved.
func (in TargetInput) Problems() Problems {
	p := Problems{}
	for field, err := range in.problems() {
		p[field] = i18n.Localize(err)
	}
	return p
}

// problems returns the form's field errors, by field. Create and Update refuse the first of them,
// and Problems shows them all.
func (in TargetInput) problems() map[string]error {
	p := map[string]error{}
	if !knownProvider(in.Provider) {
		p["provider"] = errs.Field("provider", "No such provider.")
		return p
	}
	email := in.Provider == NotificationProviderEmail
	if strings.TrimSpace(in.Name) == "" {
		switch in.Provider {
		case NotificationProviderTelegram:
			p["name"] = errs.Field("name", "Name, bot token and chat ID are required.")
		case NotificationProviderEmail:
			p["name"] = errs.Field("name", "Name and at least one address are required.")
		default:
			p["name"] = errs.Field("name", "Name and webhook URL are required.")
		}
	}
	if in.Provider == NotificationProviderTelegram {
		token, chatID := telegramProblems(strings.TrimSpace(in.URL))
		if token != nil {
			p["url"] = token
		}
		if chatID != nil {
			p["chatId"] = chatID
		}
	} else if err := validateURL(in.Provider, in.URL); err != nil {
		p["url"] = err
	}
	for _, e := range in.Events {
		if _, ok := lookup(e); !ok {
			// i18n: The value is an event's id, such as "job.failed".
			p["events"] = errs.Field("events", "%q is not a notification event.", e)
			return p
		}
	}
	if len(in.Events) == 0 {
		if email {
			p["events"] = errs.Field("events", "Select at least one event. To keep these addresses without notifications, use the Enabled switch instead.")
		} else {
			p["events"] = errs.Field("events", "Select at least one event. To keep this webhook without notifications, use the Enabled switch instead.")
		}
	}
	return p
}

// duplicate is the error for a url that another target already uses.
func duplicate(provider NotificationProvider) error {
	switch provider {
	case NotificationProviderEmail:
		return errs.Field("url", "An email notification to these addresses is already configured.")
	case NotificationProviderTelegram:
		return errs.Field("url", "This bot already sends to this chat.")
	}
	return errs.Field("url", "A webhook with this URL is already configured.")
}

// mailbox checks that address is one bare address, as the send needs it. "name <a@b>" is not
// accepted.
func mailbox(address string) (string, error) {
	address = strings.TrimSpace(address)
	a, err := mail.ParseAddress(address)
	if err != nil || a.Name != "" || a.Address != address {
		return "", errs.Errorf(notAnAddress, address)
	}
	return address, nil
}

// problems returns the SMTP form's field errors, by field. An empty host clears the settings, so
// it has no errors.
func (in SMTPInput) problems() map[string]error {
	p := map[string]error{}
	if strings.TrimSpace(in.Host) == "" {
		return p
	}
	if in.Port < 1 || in.Port > 65535 {
		p["port"] = errs.Field("port", "Enter a port between 1 and 65535.")
	}
	switch in.Encryption {
	case SMTPEncryptionStartTLS, SMTPEncryptionTLS, SMTPEncryptionNone:
	default:
		p["encryption"] = errs.Field("encryption", "Choose STARTTLS, SSL / TLS or None for the encryption.")
	}
	if from := strings.TrimSpace(in.FromAddress); from == "" {
		p["fromAddress"] = errs.Field("fromAddress", "Enter the from address, as in rclone-ui@example.com.")
	} else if _, err := mailbox(from); err != nil {
		p["fromAddress"] = errs.Field("fromAddress", notAnAddress, from)
	}
	return p
}
