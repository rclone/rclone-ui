package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/notifications goldens")

// goldenTargets has one target per provider. The Telegram one has a thread id, to show that every
// query parameter moves into the body.
var goldenTargets = []struct {
	provider NotificationProvider
	url      string
}{
	{NotificationProviderDiscord, "https://discord.com/api/webhooks/1234567890/AbC-dEf_123"},
	{NotificationProviderEmail, "ops@example.com, alice@example.com"},
	{NotificationProviderSlack, "https://hooks.slack.com/services/T000AAA/B000BBB/xyz123"},
	{NotificationProviderTelegram, "https://api.telegram.org/bot123456:ABC-def_ghi/sendMessage?chat_id=-1001234567890&message_thread_id=7"},
	{NotificationProviderWebhook, "https://example.com/hooks/rclone"},
}

// goldenEvents covers every catalog event and the test send. Each name is the name of its golden
// file.
var goldenEvents = []struct {
	name  string
	event NotificationEvent
	p     Payload
}{
	{"job.started", NotificationEventJobStarted, Job{JobID: 42, Operation: "copy",
		Sources: []string{"gdrive:Photos/2024", "gdrive:Photos/2025", "local:/home/me/Pictures"}, Destination: "s3:backup/photos"}},
	{"job.completed", NotificationEventJobCompleted, Job{JobID: 42, Operation: "sync",
		Sources: []string{"gdrive:Photos"}, Destination: "s3:backup/photos", DurationSeconds: new(int64(95))}},
	{"job.failed", NotificationEventJobFailed, Job{JobID: 43, Operation: "delete",
		Sources: []string{"s3:old/a.txt", "s3:old/b.txt"}, DurationSeconds: new(int64(0)), Error: "2 files failed: 403 Forbidden"}},
	{"job.completed-scheduled", NotificationEventJobCompleted, Job{JobID: 44, Operation: "sync",
		Sources: []string{"/Users/me/Photos"}, Destination: "gdrive:Photos", DurationSeconds: new(int64(12)),
		Schedule: "Nightly photos"}},
	{"job.failed-scheduled", NotificationEventJobFailed, Job{JobID: 45, Operation: "copy",
		Sources: []string{"/Users/me/Documents"}, Destination: "sftp:backup", DurationSeconds: new(int64(1)),
		Error: "couldn't connect", Schedule: "Documents backup"}},
	{"watcher.failed", NotificationEventWatcherFailed, WatcherFailed{Name: "Documents", PathA: "/Users/me/Documents",
		PathB: "gdrive:Documents", Error: "couldn't connect: dial tcp 127.0.0.1:22: connection refused\nmore detail"}},
	{"mount.failed", NotificationEventMountFailed, MountFailed{Source: "gdrive:", Destination: "/mnt/gdrive",
		Error: "The selected directory must be empty to mount a remote."}},
	{"mount.failed-skipped", NotificationEventMountFailed, MountFailed{Source: "gdrive:Work", Destination: "/mnt/work",
		Error: "directory not found", Skipped: true}},
	{"serve.failed", NotificationEventServeFailed, ServeFailed{Type: "webdav", Addr: "127.0.0.1:8080", Source: "s3:bucket",
		Error: "exited with status 1"}},
	{"app.crashed", NotificationEventAppCrashed, Crashed{Crashes: 2, Error: "signal: killed"}},
	{"app.update-available", NotificationEventUpdateAvailable, UpdateAvailable{Version: "3.1.0", Current: "3.0.2",
		Notes: "Faster listings & fixes"}},
}

// TestPayloadGoldens renders every event for every provider, sends the webhooks through the
// real sending path, and compares what the endpoints receive with testdata/notifications.
func TestPayloadGoldens(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)
	ft := &fakeTransport{}
	s := &Service{client: &http.Client{Transport: ft}, version: "1.2.3", retryDelay: time.Millisecond}

	type golden struct {
		name string
		msg  message
	}
	var all []golden
	for _, g := range goldenEvents {
		meta, ok := lookup(g.event)
		if !ok {
			t.Fatalf("%s: not in the catalog", g.event)
		}
		title, body := g.p.Message(g.event)
		all = append(all, golden{g.name, message{meta: meta, title: title, body: body, data: g.p, at: at}})
	}
	title, body := testMessage(`Ops <alerts> & "friends"`)
	all = append(all, golden{"test", message{meta: testEvent.meta(), title: title, body: body, at: at}})

	covered := map[NotificationEvent]bool{}
	for _, g := range all {
		covered[g.msg.meta.ID] = true
		out := map[NotificationProvider]any{}
		for _, target := range goldenTargets {
			if target.provider == NotificationProviderEmail {
				out[target.provider] = map[string]any{
					"to":      recipients(target.url),
					"subject": g.msg.title,
					"text":    s.mailText(g.msg.body),
				}
				continue
			}
			r, err := buildRequest(target.provider, target.url, g.msg, s.version)
			if err != nil {
				t.Fatalf("%s/%s: %v", g.name, target.provider, err)
			}
			ft.set(nil)
			if err := s.post(context.Background(), r); err != nil {
				t.Fatalf("%s/%s: %v", g.name, target.provider, err)
			}
			calls := ft.got()
			if len(calls) != 1 {
				t.Fatalf("%s/%s: %d calls", g.name, target.provider, len(calls))
			}
			c := calls[0]
			headers := map[string]string{"Content-Type": c.ContentType}
			if c.Event != "" {
				headers["X-RcloneUI-Event"] = c.Event
			}
			out[target.provider] = map[string]any{"url": c.URL, "headers": headers, "body": json.RawMessage(c.Body)}
		}
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join("testdata", "notifications", g.name+".json")
		if *update {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (go test -run TestPayloadGoldens -update writes it)", err)
		}
		if !bytes.Equal(b.Bytes(), want) {
			t.Errorf("%s differs from %s:\n%s", g.name, path, b.String())
		}
	}
	for _, e := range events {
		if !covered[e.ID] {
			t.Errorf("no golden for %s", e.ID)
		}
	}
}

func TestPayloadShapes(t *testing.T) {
	meta, _ := lookup(NotificationEventJobFailed)
	m := message{meta: meta, title: "A <b>", body: "B & C", data: map[string]string{"k": "v"},
		at: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	decode := func(p NotificationProvider, url string) (request, map[string]any) {
		r, err := buildRequest(p, url, m, "1.2.3")
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.Unmarshal(r.body, &body); err != nil {
			t.Fatal(err)
		}
		return r, body
	}
	// Slack's markup is escaped, so there is no link and no mention.
	if r, b := decode(NotificationProviderSlack, "https://hooks.slack.com/services/T/B/x"); b["text"] != "*A &lt;b&gt;*\nB &amp; C" || r.event != "" {
		t.Errorf("slack: %v %q", b, r.event)
	}
	if _, b := decode(NotificationProviderDiscord, "https://discord.com/api/webhooks/1/x"); b["username"] != "Rclone UI" ||
		b["embeds"].([]any)[0].(map[string]any)["color"] != float64(0xe74c3c) {
		t.Errorf("discord: %v", b)
	}
	r, b := decode(NotificationProviderTelegram, "https://api.telegram.org/bot1:x/sendMessage?chat_id=-100123")
	if r.url != "https://api.telegram.org/bot1:x/sendMessage" || b["chat_id"] != "-100123" || b["parse_mode"] != "HTML" ||
		b["text"] != "<b>A &lt;b&gt;</b>\nB &amp; C" {
		t.Errorf("telegram: %s %v", r.url, b)
	}
	r, b = decode(NotificationProviderWebhook, "https://example.com/hook")
	if r.event != NotificationEventJobFailed || b["source"] != "rclone-ui" || b["version"] != "1.2.3" ||
		b["event"] != "job.failed" || b["label"] != "Transfer failed" || b["severity"] != "error" ||
		b["timestamp"] != "2026-01-01T00:00:00.000Z" || b["data"].(map[string]any)["k"] != "v" {
		t.Errorf("webhook: %v", b)
	}
	for sev, color := range map[NotificationSeverity]int{"success": 0x2ecc71, "error": 0xe74c3c, "info": 0x3498db} {
		if got := discordColor(sev); got != color {
			t.Errorf("color %s = %#x", sev, got)
		}
	}
}

// TestLongTextIsCut: Telegram and Discord refuse a text over their limit, so a long body is cut
// to fit, counted in UTF-16 code units as they count it. Slack and generic webhooks get it whole.
func TestLongTextIsCut(t *testing.T) {
	meta, _ := lookup(NotificationEventJobFailed)
	// "😀" is two UTF-16 code units, and "&" counts as one once Telegram reads the HTML.
	long := strings.Repeat("a&😀", 3000)
	m := message{meta: meta, title: "Transfer failed", body: long, at: time.Now()}
	body := func(p NotificationProvider, url string) map[string]any {
		r, err := buildRequest(p, url, m, "1.2.3")
		if err != nil {
			t.Fatal(err)
		}
		var b map[string]any
		if err := json.Unmarshal(r.body, &b); err != nil {
			t.Fatal(err)
		}
		return b
	}

	text := body(NotificationProviderTelegram, "https://api.telegram.org/bot1:x/sendMessage?chat_id=1")["text"].(string)
	shown := strings.NewReplacer("<b>", "", "</b>", "", "&amp;", "&").Replace(text)
	if n := textLen(shown); n > telegramTextMax || n < telegramTextMax-2 || !strings.HasSuffix(shown, "…") {
		t.Errorf("telegram: %d units, ends %q", n, shown[len(shown)-12:])
	}
	if !strings.HasPrefix(text, "<b>Transfer failed</b>\n") {
		t.Errorf("telegram starts %q", text[:30])
	}

	embed := body(NotificationProviderDiscord, "https://discord.com/api/webhooks/1/x")["embeds"].([]any)[0].(map[string]any)
	if d := embed["description"].(string); textLen(d) > discordDescriptionMax || textLen(d) < discordDescriptionMax-2 || !strings.HasSuffix(d, "…") {
		t.Errorf("discord description: %d units", textLen(d))
	}
	m.title = strings.Repeat("t", 300)
	embed = body(NotificationProviderDiscord, "https://discord.com/api/webhooks/1/x")["embeds"].([]any)[0].(map[string]any)
	if d := embed["title"].(string); textLen(d) != discordTitleMax {
		t.Errorf("discord title: %d units", textLen(d))
	}

	m.title = "Transfer failed"
	if b := body(NotificationProviderWebhook, "https://example.com/hook"); b["body"] != long {
		t.Error("the generic webhook's body was cut")
	}
	// A short text is left as it is.
	if clip("héllo", 5) != "héllo" || clip("héllo!", 5) != "héll…" || clip("😀😀😀", 5) != "😀😀…" {
		t.Errorf("clip: %q %q %q", clip("héllo", 5), clip("héllo!", 5), clip("😀😀😀", 5))
	}
}

func TestWebhookRetry(t *testing.T) {
	refused := errors.New("dial tcp 10.0.0.1:443: connect: connection refused")
	for _, c := range []struct {
		name    string
		replies []any // a status, or an error
		calls   int
		err     string
	}{
		{"ok", []any{200}, 1, ""},
		{"a 204 is ok", []any{204}, 1, ""},
		{"a 5xx is tried again", []any{503, 200}, 2, ""},
		{"a network error is tried again", []any{refused, 202}, 2, ""},
		{"two 5xx", []any{500, 502}, 2, "Webhook responded with status 502"},
		{"two network errors", []any{refused, refused}, 2, refused.Error()},
		{"a 429 is tried again", []any{429, 204}, 2, ""},
		{"two 429s", []any{429, 429}, 2, "Webhook responded with status 429"},
		{"a 4xx is not tried again", []any{404}, 1, "Webhook responded with status 404"},
		{"a 3xx left as it is", []any{304}, 1, "Webhook responded with status 304"},
	} {
		t.Run(c.name, func(t *testing.T) {
			ft := &fakeTransport{}
			ft.set(func(n int, _ *http.Request) (int, error) {
				if n >= len(c.replies) {
					t.Errorf("call %d: more calls than expected", n+1)
					return 200, nil
				}
				if err, ok := c.replies[n].(error); ok {
					return 0, err
				}
				return c.replies[n].(int), nil
			})
			s := &Service{client: &http.Client{Transport: ft}, retryDelay: time.Millisecond}
			err := s.post(context.Background(), request{url: "https://hooks.slack.com/services/T/B/secret", body: []byte(`{}`)})
			if got := len(ft.got()); got != c.calls {
				t.Errorf("%d calls, want %d", got, c.calls)
			}
			switch {
			case c.err == "" && err != nil:
				t.Errorf("err = %v", err)
			case c.err != "" && (err == nil || err.Error() != c.err):
				t.Errorf("err = %v, want %q", err, c.err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Errorf("the error shows the URL: %v", err)
			}
		})
	}
}

func TestWebhookRetryStopsWithItsContext(t *testing.T) {
	ft := &fakeTransport{}
	ft.set(func(int, *http.Request) (int, error) { return 503, nil })
	s := &Service{client: &http.Client{Transport: ft}, retryDelay: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	start := time.Now()
	err := s.post(ctx, request{url: "https://example.com/hook", body: []byte(`{}`)})
	if err == nil || time.Since(start) > 5*time.Second || len(ft.got()) != 1 {
		t.Fatalf("err %v after %s, %d calls", err, time.Since(start), len(ft.got()))
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestRefusalReason: a refused call is reported with the reason the service gave, so that the
// target's error says what to fix ("chat not found") rather than only a status.
func TestRefusalReason(t *testing.T) {
	for _, c := range []struct{ body, contentType, want string }{
		{`{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`, "application/json", "Bad Request: chat not found"},
		{`{"message": "Unknown Webhook", "code": 10015}`, "application/json; charset=utf-8", "Unknown Webhook"},
		// Slack answers with an error code, as text/html.
		{"no_team", "text/html", "no_team (the webhook's URL is wrong)"},
		{"invalid_token", "text/plain; charset=utf-8", "invalid_token (the webhook's URL is wrong, or it was revoked)"},
		{"  no_service\n", "text/html", "no_service (the webhook was removed, or its URL is wrong)"},
		{"rollup_error", "text/html", "rollup_error"},
		{"Bad gateway", "text/html", ""},
		// Nothing short and readable: the status alone.
		{"<html><body>Bad gateway</body></html>", "text/html", ""},
		{strings.Repeat("x", 400), "text/plain", ""},
		{`{"ok":false}`, "application/json", ""},
		{`not json`, "application/json", ""},
		// A secret in the reply is hidden as in any error.
		{"cannot reach https://u:hunter2@example.com", "text/plain", "cannot reach https://u:***@example.com"},
	} {
		if got := refusal([]byte(c.body), c.contentType); got != c.want {
			t.Errorf("refusal(%q, %q) = %q, want %q", c.body, c.contentType, got, c.want)
		}
	}

	f := newFixture(t)
	f.s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		_, _ = io.Copy(io.Discard, r.Body)
		return &http.Response{StatusCode: 403, Request: r, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(`{"ok":false,"error_code":403,"description":"Forbidden: bot can't initiate conversation with a user"}`))}, nil
	})}
	o, err := f.s.Test(f.ctx, TestInput{Provider: NotificationProviderTelegram, Name: "TG",
		URL: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42"})
	if err != nil || o.OK || o.Message != "Telegram responded with status 403: Forbidden: bot can't initiate conversation with a user" {
		t.Errorf("test = %+v, %v", o, err)
	}
}

// TestRetryWaitsAsAsked: a 429 says how long to wait, in Retry-After (Slack, Discord) or in
// Telegram's retry_after. The retry waits that long, unless it is over maxRetryWait, in which case
// there is no retry.
func TestRetryWaitsAsAsked(t *testing.T) {
	h := func(k, v string) http.Header { return http.Header{k: {v}} }
	for _, c := range []struct {
		header http.Header
		body   string
		want   time.Duration
	}{
		{h("Retry-After", "3"), "", 3 * time.Second},
		{h("Retry-After", "0.25"), "", 250 * time.Millisecond},
		{http.Header{}, `{"ok":false,"error_code":429,"parameters":{"retry_after":5}}`, 5 * time.Second},
		{http.Header{}, `{"ok":false}`, 0},
		// Discord's body, when the header is missing.
		{http.Header{}, `{"message": "You are being rate limited.", "retry_after": 1.5, "global": false}`, 1500 * time.Millisecond},
		{h("Retry-After", "Wed, 21 Oct 2026 07:28:00 GMT"), "", 0},
	} {
		if got := retryWait(c.header, []byte(c.body)); got != c.want {
			t.Errorf("retryWait(%v, %s) = %s, want %s", c.header, c.body, got, c.want)
		}
	}

	f := newFixture(t)
	f.s.retryDelay = time.Millisecond
	var mu sync.Mutex
	var calls []time.Time
	reply := func(retryAfter string) {
		f.s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			_, _ = io.Copy(io.Discard, r.Body)
			mu.Lock()
			calls = append(calls, time.Now())
			n := len(calls)
			mu.Unlock()
			if n == 1 {
				return &http.Response{StatusCode: 429, Request: r, Header: http.Header{"Content-Type": {"application/json"}},
					Body: io.NopCloser(strings.NewReader(`{"ok":false,"error_code":429,"description":"Too Many Requests: retry after ` +
						retryAfter + `","parameters":{"retry_after":` + retryAfter + `}}`))}, nil
			}
			return &http.Response{StatusCode: 200, Request: r, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
		})}
	}
	bot := TestInput{Provider: NotificationProviderTelegram, Name: "TG", URL: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42"}

	reply("0.3")
	if o, err := f.s.Test(f.ctx, bot); err != nil || !o.OK || len(calls) != 2 || calls[1].Sub(calls[0]) < 300*time.Millisecond {
		t.Errorf("a short wait: %+v %v, %d calls", o, err, len(calls))
	}
	calls = nil
	reply("90")
	o, err := f.s.Test(f.ctx, bot)
	if err != nil || o.OK || len(calls) != 1 || o.Message != "Telegram responded with status 429: Too Many Requests: retry after 90" {
		t.Errorf("a wait over the limit: %+v %v, %d calls", o, err, len(calls))
	}
}
