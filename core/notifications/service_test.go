package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

var system = context.Background()

func TestNotifyDeliversToSubscribedTargets(t *testing.T) {
	f := newFixture(t)
	hookT := f.create(hook("https://example.com/hook", NotificationEventJobFailed, NotificationEventJobStarted))
	off := hook("https://example.com/off")
	off.IsEnabled = false
	offT := f.create(off)
	otherT := f.create(TargetInput{Provider: NotificationProviderDiscord, Name: "D", URL: "https://discord.com/api/webhooks/1/x",
		Events: []NotificationEvent{NotificationEventMountFailed}, IsEnabled: true})
	tgT := f.create(TargetInput{Provider: NotificationProviderTelegram, Name: "TG",
		URL: "https://api.telegram.org/bot1:x/sendMessage?chat_id=-100123", Events: []NotificationEvent{NotificationEventJobFailed}, IsEnabled: true})

	f.s.Notify(system, NotificationEventJobFailed, Job{JobID: 7, Operation: "copy", Sources: []string{"a:"}, Destination: "b:", Error: "boom"})
	f.changed(2)
	calls := f.hooks.got()
	if len(calls) != 2 {
		t.Fatalf("calls = %+v", calls)
	}
	byURL := map[string]captured{}
	for _, c := range calls {
		byURL[c.URL] = c
	}
	generic := byURL["https://example.com/hook"]
	var body struct {
		Event string `json:"event"`
		Title string `json:"title"`
		Body  string `json:"body"`
		Data  struct {
			JobID int64  `json:"jobid"`
			Error string `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(generic.Body), &body); err != nil || generic.Event != "job.failed" ||
		generic.ContentType != "application/json" || body.Title != "Transfer failed" ||
		body.Body != "copy of a: to b: — boom" || body.Data.JobID != 7 || body.Data.Error != "boom" {
		t.Errorf("generic call = %+v (%v)", generic, err)
	}
	if tg, ok := byURL["https://api.telegram.org/bot1:x/sendMessage"]; !ok || !strings.Contains(tg.Body, `"chat_id":"-100123"`) {
		t.Errorf("telegram call = %+v", calls)
	}
	for _, c := range []struct {
		id   string
		sent bool
	}{{hookT.ID, true}, {tgT.ID, true}, {offT.ID, false}, {otherT.ID, false}} {
		got := f.get(c.id)
		if (got.LastSentAt != nil) != c.sent || got.LastError != "" {
			t.Errorf("%s: last sent %v, error %q; want sent %v", got.Name, got.LastSentAt, got.LastError, c.sent)
		}
	}

	// A failure is recorded, and the next success clears it.
	f.hooks.set(func(int, *http.Request) (int, error) { return 404, nil })
	f.s.Notify(system, NotificationEventJobStarted, Job{Operation: "copy"})
	f.changed(1)
	if got := f.get(hookT.ID); got.LastError != "Webhook responded with status 404" {
		t.Errorf("after a 404: %+v", got)
	}
	f.hooks.set(nil)
	f.s.Notify(system, NotificationEventJobStarted, Job{Operation: "copy"})
	f.changed(1)
	if got := f.get(hookT.ID); got.LastError != "" {
		t.Errorf("after a success: %+v", got)
	}
}

// TestNotifyPastACorruptTarget checks that a target whose events are not valid JSON gets its
// error recorded, and that the other targets still get the notification.
func TestNotifyPastACorruptTarget(t *testing.T) {
	f := newFixture(t)
	bad := f.create(hook("https://example.com/bad"))
	good := f.create(hook("https://example.com/good"))
	if err := f.db.Write(f.ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE notification_targets SET events = '["job.failed"' WHERE id = ?`, bad.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	f.s.Notify(system, NotificationEventJobFailed, Job{JobID: 1, Operation: "copy"})
	f.changed(2)
	if calls := f.hooks.got(); len(calls) != 1 || calls[0].URL != "https://example.com/good" {
		t.Fatalf("calls = %+v", calls)
	}
	if got := f.get(good.ID); got.LastSentAt == nil || got.LastError != "" {
		t.Errorf("the good target: %+v", got)
	}
	var lastErr sql.NullString
	if err := f.db.Read(f.ctx, func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT last_error FROM notification_targets WHERE id = ?`, bad.ID).Scan(&lastErr)
	}); err != nil || !strings.Contains(lastErr.String, "events") {
		t.Errorf("the corrupt target's error: %q (%v)", lastErr.String, err)
	}

	// The list still shows both. The corrupt one has no events and says what to do.
	list, err := f.s.Targets(f.ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("Targets = %+v, %v", list, err)
	}
	if list[0].ID != bad.ID || list[0].Events != nil || list[0].LastError != unreadableEvents {
		t.Errorf("the corrupt target listed: %+v", list[0])
	}
	if list[1].ID != good.ID || len(list[1].Events) == 0 {
		t.Errorf("the good target listed: %+v", list[1])
	}

	// Saving it again with its events fixes it.
	in := hook("https://example.com/bad")
	if _, err := f.s.Update(f.ctx, bad.ID, in); err != nil {
		t.Fatal(err)
	}
	if list, err := f.s.Targets(f.ctx); err != nil || len(list[0].Events) == 0 {
		t.Errorf("after saving it again: %+v, %v", list, err)
	}
}

// TestPayloadsHideCredentials checks that a connection string's secret and a URL's password, in a
// job's paths or its error, never reach a webhook, either in the generic webhook's data or in
// Discord's text.
func TestPayloadsHideCredentials(t *testing.T) {
	f := newFixture(t)
	f.create(hook("https://example.com/hook"))
	f.create(TargetInput{Provider: NotificationProviderDiscord, Name: "D", URL: "https://discord.com/api/webhooks/1/x",
		Events: []NotificationEvent{NotificationEventJobFailed}, IsEnabled: true})

	src := ":s3,secret_access_key=XYZSECRET:bucket"
	f.s.Notify(system, NotificationEventJobFailed, Job{JobID: 1, Operation: "copy", Sources: []string{src},
		Destination: ":webdav,url='https://u:hunter2@dav.example.com':x", Error: "couldn't list " + src + ": AccessDenied"})
	f.changed(2)
	calls := f.hooks.got()
	if len(calls) != 2 {
		t.Fatalf("calls = %+v", calls)
	}
	for _, c := range calls {
		if strings.Contains(c.Body, "XYZSECRET") || strings.Contains(c.Body, "hunter2") || !strings.Contains(c.Body, "secret_access_key=***") {
			t.Errorf("%s got %s", c.URL, c.Body)
		}
	}
}

func TestNotifyKeepsEachTargetsOrderAndLanesApart(t *testing.T) {
	f := newFixture(t)
	slow := f.create(hook("https://example.com/slow", NotificationEventJobStarted))
	// A second target on another lane, so the slow one can't hold it up.
	var fast NotificationTarget
	for i := 0; ; i++ {
		fast = f.create(hook(fmt.Sprintf("https://example.com/fast/%d", i), NotificationEventJobStarted))
		if laneOf(fast.ID) != laneOf(slow.ID) {
			break
		}
		if err := f.s.Delete(f.ctx, fast.ID); err != nil {
			t.Fatal(err)
		}
		f.changed(1)
	}
	release := make(chan struct{})
	f.hooks.set(func(_ int, r *http.Request) (int, error) {
		if strings.HasSuffix(r.URL.Path, "/slow") {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		return 200, nil
	})
	for i := range 5 {
		f.s.Notify(system, NotificationEventJobStarted, Job{JobID: int64(i), Operation: "copy"})
	}
	// Every notification reached the fast target while the slow one is still stuck on its
	// first.
	f.changed(5)
	if got := f.get(slow.ID); got.LastSentAt != nil {
		t.Fatalf("the slow target was recorded before it answered: %+v", got)
	}
	close(release)
	f.changed(5)

	var slowIDs, fastIDs []int64
	for _, c := range f.hooks.got() {
		var b struct {
			Data struct {
				JobID int64 `json:"jobid"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(c.Body), &b); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(c.URL, "/slow") {
			slowIDs = append(slowIDs, b.Data.JobID)
		} else {
			fastIDs = append(fastIDs, b.Data.JobID)
		}
	}
	for _, ids := range [][]int64{slowIDs, fastIDs} {
		if fmt.Sprint(ids) != "[0 1 2 3 4]" {
			t.Errorf("order = %v", ids)
		}
	}
}

func TestNotifyEmail(t *testing.T) {
	f := newFixture(t)
	mailed := f.create(TargetInput{Provider: NotificationProviderEmail, Name: "Ops", URL: "ops@example.com, alice@example.com",
		Events: []NotificationEvent{NotificationEventServeFailed}, IsEnabled: true})
	failed := ServeFailed{Type: "webdav", Addr: "127.0.0.1:8080", Source: "s3:bucket", Error: "boom"}

	// With no mail server saved, the reason becomes the target's last error.
	f.s.Notify(system, NotificationEventServeFailed, failed)
	f.changed(1)
	if got := f.get(mailed.ID); got.LastError != errNotSetUp.Error() || got.LastSentAt == nil {
		t.Fatalf("without SMTP: %+v", got)
	}

	srv := newFakeSMTP(t, false, nil)
	f.saveSMTP(smtpInput(srv.port(), SMTPEncryptionNone))
	f.s.Notify(system, NotificationEventServeFailed, failed)
	f.changed(1)
	if got := f.get(mailed.ID); got.LastError != "" {
		t.Fatalf("with SMTP: %+v", got)
	}
	session := srv.got()[0]
	for _, want := range []string{"RCPT TO:<ops@example.com>", "RCPT TO:<alice@example.com>", "Subject: Serve failed",
		"Failed to serve s3:bucket over webdav on 127.0.0.1:8080: boom"} {
		if !strings.Contains(session, want) {
			t.Errorf("session lacks %q:\n%s", want, session)
		}
	}
}

func TestNotifyNeverBlocks(t *testing.T) {
	// Start isn't called, so no sender runs. The queue fills up, and Notify still returns at once.
	s := New(nil, nil, nil, nil, nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range queueSize + 50 {
			s.Notify(context.Background(), NotificationEventJobStarted, Job{Operation: "copy"})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Notify blocked on a full queue")
	}
	if len(s.queue) != queueSize {
		t.Errorf("queued %d", len(s.queue))
	}
	s = New(nil, nil, nil, nil, nil)
	s.Notify(context.Background(), "schedule.failed", Job{})
	if len(s.queue) != 0 {
		t.Error("an event not in the catalog was queued")
	}
}

func TestTest(t *testing.T) {
	f := newFixture(t)
	saved := f.create(hook("https://example.com/saved"))

	// The unsaved form is sent, and nothing is recorded.
	o, err := f.s.Test(f.ctx, TestInput{Provider: NotificationProviderWebhook, URL: " https://example.com/form ", Name: "Form"})
	if err != nil || !o.OK || o.Message != "Test notification sent successfully." {
		t.Fatalf("form test = %+v, %v", o, err)
	}
	calls := f.hooks.got()
	if len(calls) != 1 || calls[0].URL != "https://example.com/form" || calls[0].Event != "test" ||
		!strings.Contains(calls[0].Body, `for \"Form\".`) {
		t.Fatalf("form test calls = %+v", calls)
	}
	if !f.quiet(50 * time.Millisecond) {
		t.Error("an unsaved test published a change")
	}

	// A saved target uses its saved values, and the outcome is recorded.
	f.hooks.set(func(int, *http.Request) (int, error) { return 410, nil })
	o, err = f.s.Test(f.ctx, TestInput{ID: saved.ID, URL: "https://example.com/ignored"})
	if err != nil || o.OK || o.Message != "Webhook responded with status 410" {
		t.Fatalf("saved test = %+v, %v", o, err)
	}
	f.changed(1)
	if got := f.get(saved.ID); got.LastSentAt == nil || got.LastError != "Webhook responded with status 410" {
		t.Errorf("saved target after its test: %+v", got)
	}
	if calls := f.hooks.got(); len(calls) != 1 || calls[0].URL != "https://example.com/saved" {
		t.Errorf("saved test calls = %+v", calls)
	}

	// An email form goes through the saved server, and none is saved.
	o, err = f.s.Test(f.ctx, TestInput{Provider: NotificationProviderEmail, URL: "ops@example.com"})
	if err != nil || o.OK || o.Message != errNotSetUp.Error() {
		t.Errorf("email test = %+v, %v", o, err)
	}

	for _, c := range []struct {
		in    TestInput
		field string
	}{
		{TestInput{Provider: NotificationProviderSlack, URL: "https://example.com"}, "url"},
		{TestInput{Provider: "pager", URL: "https://example.com"}, "provider"},
	} {
		var ae *errs.FieldError
		if _, err := f.s.Test(f.ctx, c.in); !errors.As(err, &ae) || ae.Field != c.field {
			t.Errorf("%+v: %v, want a refusal of %s", c.in, err, c.field)
		}
	}
	if _, err := f.s.Test(f.ctx, TestInput{ID: "nope"}); !errors.Is(err, ErrTargetNotFound) {
		t.Errorf("a missing target: %v", err)
	}

	// A test that the caller cancelled is not recorded as the target's last error.
	quiet := f.create(hook("https://example.com/quiet"))
	ctx, cancel := context.WithCancel(f.ctx)
	f.hooks.set(func(_ int, r *http.Request) (int, error) {
		cancel()
		return 0, r.Context().Err()
	})
	if o, err := f.s.Test(ctx, TestInput{ID: quiet.ID}); err != nil || o.OK {
		t.Fatalf("a cancelled test = %+v, %v", o, err)
	}
	if got := f.get(quiet.ID); got.LastError != "" || got.LastSentAt != nil {
		t.Errorf("a cancelled test was recorded: %+v", got)
	}
}
