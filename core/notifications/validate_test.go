package notifications

import (
	"maps"
	"testing"
)

func TestValidateURL(t *testing.T) {
	const (
		discordBad  = "This doesn't look like a Discord webhook URL. Expected https://discord.com/api/webhooks/…"
		slackBad    = "This doesn't look like a Slack webhook URL. Expected https://hooks.slack.com/services/…"
		telegramBad = "This doesn't look like a bot token. Enter the token that BotFather sent, as in 123456789:AAH…"
		chatBad     = "Enter the chat ID as a number, as in 123456789 or -1001234567890, or @channelname for a public channel."
		mailBad     = "Enter one or more email addresses, separated by commas."
	)
	for _, c := range []struct {
		provider NotificationProvider
		url      string
		want     string
	}{
		{NotificationProviderDiscord, "https://discord.com/api/webhooks/123/abc-DEF_1", ""},
		{NotificationProviderDiscord, "  https://discordapp.com/api/webhooks/123/abc ", ""},
		{NotificationProviderDiscord, "https://ptb.discord.com/api/webhooks/123/abc", ""},
		{NotificationProviderDiscord, "https://canary.discord.com/api/webhooks/123/abc", ""},
		{NotificationProviderDiscord, "http://discord.com/api/webhooks/123/abc", discordBad},
		{NotificationProviderDiscord, "https://discord.com/api/webhooks/abc/abc", discordBad},
		{NotificationProviderDiscord, "https://discord.com/api/webhooks/123/abc?wait=true", discordBad},
		{NotificationProviderDiscord, "", "A webhook URL is required"},
		{NotificationProviderSlack, "https://hooks.slack.com/services/T0123/B0456/abcXYZ_09", ""},
		{NotificationProviderSlack, "https://hooks.slack.com/services/t0123/B0456/abc", slackBad},
		{NotificationProviderSlack, "https://hooks.slack.com/workflows/T0123/B0456/abc", slackBad},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA-b_c/sendMessage?chat_id=-100123", ""},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA/sendMessage?chat_id=@mychannel", ""},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA/sendMessage?chat_id=%40mychannel&message_thread_id=7", ""},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA/sendMessage", "A chat ID is required"},
		{NotificationProviderTelegram, "https://api.telegram.org/bot/sendMessage?chat_id=1", "A bot token is required"},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA/sendMessage?chat_id=@abc", chatBad},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA/sendMessage?chat_id=12a", chatBad},
		{NotificationProviderTelegram, "https://api.telegram.org/bot123:AA", telegramBad},
		{NotificationProviderTelegram, "https://api.telegram.org/botabc:AA/sendMessage?chat_id=1", telegramBad},
		{NotificationProviderTelegram, "https://api.telegram.org/bot1:AA/sendMessage?chat_id=1\r\n", ""}, // trimmed
		{NotificationProviderTelegram, "https://api.telegram.org/bot1:AA/sendMessage?chat_id=1\rx", telegramBad},
		{NotificationProviderWebhook, "https://example.com/hooks/rclone", ""},
		{NotificationProviderWebhook, "HTTP://example.com:8080/x?y=1", ""},
		{NotificationProviderWebhook, "ftp://example.com/x", "The URL must use http:// or https://"},
		{NotificationProviderWebhook, "mailto:ops@example.com", "The URL must use http:// or https://"},
		{NotificationProviderWebhook, "example.com/hook", "This is not a valid URL"},
		{NotificationProviderWebhook, "http://", "This is not a valid URL"},
		{NotificationProviderWebhook, "http://exa mple.com", "This is not a valid URL"},
		{NotificationProviderWebhook, " \t", "A webhook URL is required"},
		{NotificationProviderEmail, "ops@example.com", ""},
		{NotificationProviderEmail, " ops@example.com, alice@example.co.uk ,", ""},
		{NotificationProviderEmail, "", mailBad},
		{NotificationProviderEmail, " , ", mailBad},
		// Addresses are read the same way the send reads them. A host without a dot is
		// accepted, and an address that is refused is named in the error.
		{NotificationProviderEmail, "ops@mailhost", ""},
		{NotificationProviderEmail, "Ops <ops@example.com>", "‘Ops <ops@example.com>’ is not an email address."},
		{NotificationProviderEmail, "ops@example.com; alice@example.com", "‘ops@example.com; alice@example.com’ is not an email address."},
		{NotificationProviderEmail, "ops@example.com, ops", "‘ops’ is not an email address."},
		{NotificationProviderEmail, "a@b@example.com", "‘a@b@example.com’ is not an email address."},
	} {
		got := ""
		if err := validateURL(c.provider, c.url); err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("%s %q = %q, want %q", c.provider, c.url, got, c.want)
		}
	}
}

func TestTargetProblems(t *testing.T) {
	ok := TargetInput{Provider: NotificationProviderWebhook, Name: "Hook", URL: "https://example.com/h",
		Events: []NotificationEvent{NotificationEventJobFailed}, IsEnabled: true}
	for _, c := range []struct {
		name string
		edit func(*TargetInput)
		want map[string]string
	}{
		{"ok", func(*TargetInput) {}, map[string]string{}},
		{"unknown provider", func(in *TargetInput) { in.Provider = "pager" }, map[string]string{"provider": "No such provider."}},
		{"no name", func(in *TargetInput) { in.Name = " " }, map[string]string{"name": "Name and webhook URL are required."}},
		{"no name, telegram", func(in *TargetInput) {
			in.Provider, in.Name, in.URL = NotificationProviderTelegram, "", "https://api.telegram.org/bot1:A/sendMessage?chat_id=1"
		}, map[string]string{"name": "Name, bot token and chat ID are required."}},
		{"email: no name, no events", func(in *TargetInput) {
			in.Provider, in.Name, in.URL, in.Events = NotificationProviderEmail, "", "a@b.co", nil
		}, map[string]string{
			"name":   "Name and at least one address are required.",
			"events": "Select at least one event. To keep these addresses without notifications, use the Enabled switch instead.",
		}},
		{"bad url", func(in *TargetInput) { in.URL = "nope" }, map[string]string{"url": "This is not a valid URL"}},
		// The bot token is checked as url and the chat ID as chatId, because the form has a field
		// for each.
		{"telegram: bad token and chat ID", func(in *TargetInput) {
			in.Provider, in.URL = NotificationProviderTelegram, "https://api.telegram.org/botx/sendMessage?chat_id=12a"
		}, map[string]string{
			"url":    "This doesn't look like a bot token. Enter the token that BotFather sent, as in 123456789:AAH…",
			"chatId": "Enter the chat ID as a number, as in 123456789 or -1001234567890, or @channelname for a public channel.",
		}},
		{"telegram: no chat ID", func(in *TargetInput) {
			in.Provider, in.URL = NotificationProviderTelegram, "https://api.telegram.org/bot1:A/sendMessage?chat_id="
		}, map[string]string{"chatId": "A chat ID is required"}},
		{"no events", func(in *TargetInput) { in.Events = []NotificationEvent{} }, map[string]string{
			"events": "Select at least one event. To keep this webhook without notifications, use the Enabled switch instead.",
		}},
		{"a removed event", func(in *TargetInput) { in.Events = append(in.Events, "schedule.failed") }, map[string]string{
			"events": `"schedule.failed" is not a notification event.`,
		}},
		{"the test event", func(in *TargetInput) { in.Events = []NotificationEvent{"test"} }, map[string]string{
			"events": `"test" is not a notification event.`,
		}},
	} {
		in := ok
		c.edit(&in)
		if got := in.Problems(); !maps.Equal(got, Problems(c.want)) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
