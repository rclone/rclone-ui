package notifications

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/logs"
)

// sendTimeout limits one attempt, so an endpoint that doesn't respond can't hold up the
// notifications behind it for long.
const sendTimeout = 15 * time.Second

// message is one notification, which each provider renders in its own format.
type message struct {
	meta  NotificationEventMeta
	title string
	body  string
	data  any // the generic webhook's data; nil is sent as null
	at    time.Time
}

// request is one webhook call.
type request struct {
	url  string
	body []byte
	// event is the X-RcloneUI-Event header, sent to generic webhooks only.
	event NotificationEvent
	// service names the endpoint in an error: Slack, Discord or Telegram, and "" for a generic
	// webhook.
	service string
}

// serviceNames are the names of the providers' endpoints, as errors say them.
var serviceNames = map[NotificationProvider]string{
	NotificationProviderSlack:    "Slack",
	NotificationProviderDiscord:  "Discord",
	NotificationProviderTelegram: "Telegram",
}

var discordColors = map[NotificationSeverity]int{
	NotificationSeveritySuccess: 0x2ecc71,
	NotificationSeverityError:   0xe74c3c,
}

func discordColor(s NotificationSeverity) int {
	if c, ok := discordColors[s]; ok {
		return c
	}
	return 0x3498db
}

// The longest texts that Telegram and Discord accept, counted in UTF-16 code units as they count
// them. They refuse a longer one (Telegram's "message is too long", Discord's 400), and the
// notification would be lost, so a long body (such as an error page that rclone quotes) is cut
// to fit. Slack cuts a long text itself and still posts it.
const (
	telegramTextMax       = 4096
	discordTitleMax       = 256
	discordDescriptionMax = 4096
)

// textLen returns the length of s in UTF-16 code units.
func textLen(s string) int {
	n := 0
	for _, r := range s {
		n += max(utf16.RuneLen(r), 1)
	}
	return n
}

// clip returns s cut to at most limit UTF-16 code units, ending with an ellipsis when it was cut.
func clip(s string, limit int) string {
	if textLen(s) <= limit {
		return s
	}
	n := 0
	for i, r := range s {
		w := max(utf16.RuneLen(r), 1)
		if n+w > limit-1 {
			return s[:i] + "…"
		}
		n += w
	}
	return s
}

// markupEscaper escapes the characters that Telegram's HTML and Slack's text treat as markup.
var markupEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// timestamp formats t as RFC 3339 in UTC, with milliseconds.
func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// encode returns v as JSON without Go's HTML escaping, because Telegram's text is HTML and the
// payloads should read as they were sent.
func encode(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// buildRequest renders m for a target of the given provider. version is the app's version, which
// is sent to generic webhooks.
func buildRequest(provider NotificationProvider, target string, m message, version string) (request, error) {
	var body any
	switch provider {
	case NotificationProviderSlack:
		// Slack reads <…> in text as a link or a mention, so a path or an error that contains
		// <!channel> would ping the whole channel.
		body = struct {
			Text string `json:"text"`
		}{fmt.Sprintf("*%s*\n%s", markupEscaper.Replace(m.title), markupEscaper.Replace(m.body))}
	case NotificationProviderDiscord:
		type embed struct {
			Title       string `json:"title"`
			Description string `json:"description"`
			Color       int    `json:"color"`
			Timestamp   string `json:"timestamp"`
		}
		body = struct {
			Username string  `json:"username"`
			Embeds   []embed `json:"embeds"`
		}{"Rclone UI", []embed{{clip(m.title, discordTitleMax), clip(m.body, discordDescriptionMax),
			discordColor(m.meta.Severity), timestamp(m.at)}}}
	case NotificationProviderTelegram:
		// Move every query parameter in the target (chat_id, message_thread_id, …) into the
		// JSON body, because the Bot API doesn't reliably merge a query with a JSON body.
		u, err := url.Parse(target)
		if err != nil {
			return request{}, fmt.Errorf("invalid telegram url: %w", err)
		}
		payload := map[string]string{}
		for k, vs := range u.Query() {
			payload[k] = vs[len(vs)-1]
		}
		// The limit counts the text as shown: the tags don't count, and an escaped character
		// counts as one. The title and its line break come first.
		title := clip(m.title, telegramTextMax/2)
		text := clip(m.body, telegramTextMax-textLen(title)-1)
		payload["text"] = fmt.Sprintf("<b>%s</b>\n%s", markupEscaper.Replace(title), markupEscaper.Replace(text))
		payload["parse_mode"] = "HTML"
		u.RawQuery = ""
		u.ForceQuery = false
		target, body = u.String(), payload
	default:
		body = struct {
			Source    string               `json:"source"`
			Version   string               `json:"version"`
			Event     NotificationEvent    `json:"event"`
			Label     string               `json:"label"`
			Severity  NotificationSeverity `json:"severity"`
			Title     string               `json:"title"`
			Body      string               `json:"body"`
			Timestamp string               `json:"timestamp"`
			Data      any                  `json:"data"`
		}{"rclone-ui", version, m.meta.ID, m.meta.Label, m.meta.Severity, m.title, m.body, timestamp(m.at), m.data}
	}
	raw, err := encode(body)
	if err != nil {
		return request{}, fmt.Errorf("encode the %s payload: %w", provider, err)
	}
	r := request{url: target, body: raw, service: serviceNames[provider]}
	if provider == NotificationProviderWebhook {
		r.event = m.meta.ID
	}
	return r, nil
}

// post sends r. It retries once on a network error, a 5xx, or a 429 (which a burst of events
// over Discord's, Slack's or Telegram's rate limit can cause). The retry comes after retryDelay,
// or after the wait that a 429 asks for, when that is longer and at most maxRetryWait. Any other
// 4xx means the endpoint refused the call, for example because of a bad URL or a revoked
// webhook, and retrying would only add load.
func (s *Service) post(ctx context.Context, r request) error {
	for attempt := 1; ; attempt++ {
		a := s.postOnce(ctx, r)
		if a.err == nil && a.status >= 200 && a.status < 300 {
			return nil
		}
		again := a.err != nil || a.status >= 500 || (a.status == http.StatusTooManyRequests && a.wait <= maxRetryWait)
		if attempt == 1 && again && ctx.Err() == nil {
			if sleep(ctx, max(s.retryDelay, a.wait)) == nil {
				continue
			}
		}
		if a.err != nil {
			return a.err
		}
		return refused(r.service, a)
	}
}

// refused is the error for an endpoint's answer that isn't a success. service names it (Slack,
// Discord, Telegram), and is "" for a generic webhook. The reason is the endpoint's own words.
func refused(service string, a answer) error {
	switch {
	case service == "" && a.reason != "":
		// i18n: A notification target's error. The values are the HTTP status and the reason that the webhook's server gave.
		return errs.Errorf("Webhook responded with status %d: %s", a.status, a.reason)
	case service == "":
		// i18n: A notification target's error. The value is the HTTP status.
		return errs.Errorf("Webhook responded with status %d", a.status)
	case a.reason != "":
		// i18n: A notification target's error. The values are the service (Slack, Discord, Telegram), the HTTP status and the reason it gave.
		return errs.Errorf("%s responded with status %d: %s", service, a.status, a.reason)
	}
	// i18n: A notification target's error. The values are the service (Slack, Discord, Telegram) and the HTTP status.
	return errs.Errorf("%s responded with status %d", service, a.status)
}

// maxRetryWait is the longest wait for a retry that a 429 may ask for. A longer one isn't
// waited for, because it would hold up the target's other notifications.
const maxRetryWait = 30 * time.Second

// answer is the outcome of one attempt.
type answer struct {
	status int
	// reason is why the endpoint refused the call, when it said (see refusal).
	reason string
	// wait is how long a 429 asked to wait before trying again, or 0.
	wait time.Duration
	err  error
}

// retryWait reads how long a 429 asks to wait: the Retry-After header in seconds (Slack,
// Discord), Telegram's parameters.retry_after, or Discord's retry_after.
func retryWait(header http.Header, body []byte) time.Duration {
	if secs, err := strconv.ParseFloat(strings.TrimSpace(header.Get("Retry-After")), 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	var reply struct {
		Parameters struct {
			RetryAfter float64 `json:"retry_after"`
		} `json:"parameters"`
	}
	if json.Unmarshal(body, &reply) == nil && reply.Parameters.RetryAfter > 0 {
		return time.Duration(reply.Parameters.RetryAfter * float64(time.Second))
	}
	var discord struct {
		RetryAfter float64 `json:"retry_after"`
	}
	if json.Unmarshal(body, &discord) == nil && discord.RetryAfter > 0 {
		return time.Duration(discord.RetryAfter * float64(time.Second))
	}
	return 0
}

// maxReason is the longest reason for a refusal that is kept from a response.
const maxReason = 300

// refusal returns what an endpoint said about why it refused a call: Telegram's description
// ("Bad Request: chat not found"), Discord's message ("Unknown Webhook"), Slack's error code
// ("no_service", sent as text/html), or another short plain-text answer. It returns "" when the
// body holds nothing short and readable, such as an HTML error page.
func refusal(body []byte, contentType string) string {
	var reply struct {
		Description string `json:"description"`
		Message     string `json:"message"`
	}
	trimmed := strings.TrimSpace(string(body))
	text := ""
	switch {
	case strings.HasPrefix(contentType, "application/json"):
		if json.Unmarshal(body, &reply) == nil {
			text = cmp.Or(reply.Description, reply.Message)
		}
	case strings.HasPrefix(contentType, "text/plain"), reErrorCode.MatchString(trimmed):
		text = trimmed
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" || textLen(text) > maxReason || !utf8.ValidString(text) {
		return ""
	}
	if hint, ok := slackErrors[text]; ok {
		text += " (" + hint + ")"
	}
	return logs.Redact(text)
}

// reErrorCode matches an error code on its own, as Slack answers: "no_service", "invalid_token".
var reErrorCode = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)+$`)

// slackErrors explain the codes that Slack answers a webhook with when the webhook itself is the
// problem, so that the target's error says what to do.
var slackErrors = map[string]string{
	"no_service":                        "the webhook was removed, or its URL is wrong",
	"no_team":                           "the webhook's URL is wrong",
	"invalid_token":                     "the webhook's URL is wrong, or it was revoked",
	"channel_not_found":                 "the webhook's channel was deleted",
	"channel_is_archived":               "the webhook's channel is archived",
	"action_prohibited":                 "an admin restricted posting to the channel",
	"posting_to_general_channel_denied": "only admins can post to the channel",
}

func (s *Service) postOnce(ctx context.Context, r request) answer {
	attempt, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(attempt, http.MethodPost, r.url, bytes.NewReader(r.body))
	if err != nil {
		return answer{err: errs.New("The target's URL cannot be called.")}
	}
	req.Header.Set("Content-Type", "application/json")
	if r.event != "" {
		req.Header.Set("X-RcloneUI-Event", string(r.event))
	}
	resp, err := s.client.Do(req)
	if err != nil {
		// Leave the URL out of the error. A webhook URL is a credential (Telegram's path holds
		// the bot token), and this text is logged and shown as the target's last error.
		var ue *url.Error
		switch {
		case ctx.Err() != nil:
			return answer{err: ctx.Err()}
		case attempt.Err() != nil:
			// i18n: A notification target's error. The value is how long the app waited, as in "15s".
			return answer{err: errs.Errorf("No answer within %s.", sendTimeout)}
		case errors.As(err, &ue):
			return answer{err: ue.Err}
		}
		return answer{err: err}
	}
	// Read part of the body, for a refusal's reason and so the connection can be reused.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	a := answer{status: resp.StatusCode}
	if resp.StatusCode >= 300 {
		a.reason = refusal(body, resp.Header.Get("Content-Type"))
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		a.wait = retryWait(resp.Header, body)
	}
	return a
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
