package notifications

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

func hook(url string, events ...NotificationEvent) TargetInput {
	if len(events) == 0 {
		events = []NotificationEvent{NotificationEventJobFailed}
	}
	return TargetInput{Provider: NotificationProviderWebhook, Name: "Hook", URL: url, Events: events, IsEnabled: true}
}

func TestTargetsCRUD(t *testing.T) {
	f := newFixture(t)
	before := time.Now().UnixMilli()
	in := hook(" https://example.com/Hook ", NotificationEventJobFailed, NotificationEventMountFailed, NotificationEventJobFailed)
	in.Name = "  Team hook "
	added := f.create(in)
	if added.ID == "" || added.Name != "Team hook" || added.URL != "https://example.com/Hook" || !added.IsEnabled ||
		!slices.Equal(added.Events, []NotificationEvent{NotificationEventJobFailed, NotificationEventMountFailed}) ||
		added.CreatedAt < before || added.LastSentAt != nil || added.LastError != "" {
		t.Fatalf("added = %+v", added)
	}

	// The url is stored as entered, and its key is the hash of the lower-cased url.
	var stored, key string
	if err := f.db.Read(context.Background(), func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT url, url_key FROM notification_targets WHERE id = ?`, added.ID).Scan(&stored, &key)
	}); err != nil {
		t.Fatal(err)
	}
	if stored != "https://example.com/Hook" || key != urlKey("https://example.com/hook") {
		t.Fatalf("stored url %q, key %q", stored, key)
	}

	second := f.create(TargetInput{Provider: NotificationProviderEmail, Name: "Ops", URL: "ops@example.com, alice@example.com",
		Events: []NotificationEvent{NotificationEventServeFailed}})
	list, err := f.s.Targets(f.ctx)
	if err != nil || len(list) != 2 || list[0].ID != added.ID || list[1].ID != second.ID || list[1].IsEnabled {
		t.Fatalf("list = %+v, %v", list, err)
	}

	// An update keeps the provider and replaces the rest.
	upd, err := f.s.Update(f.ctx, added.ID, TargetInput{Name: "Renamed", URL: "https://example.com/other",
		Events: []NotificationEvent{NotificationEventServeFailed}})
	if err != nil || upd.Name != "Renamed" || upd.Provider != NotificationProviderWebhook || upd.IsEnabled ||
		upd.URL != "https://example.com/other" || !slices.Equal(upd.Events, []NotificationEvent{NotificationEventServeFailed}) ||
		upd.CreatedAt != added.CreatedAt {
		t.Fatalf("update = %+v, %v", upd, err)
	}
	f.changed(1)
	var ae *errs.FieldError
	if _, err := f.s.Update(f.ctx, added.ID, TargetInput{Provider: NotificationProviderSlack, Name: "x",
		URL: "https://hooks.slack.com/services/T1/B1/x", Events: upd.Events}); !errors.As(err, &ae) || ae.Field != "provider" {
		t.Errorf("provider change: %v", err)
	}
	if _, err := f.s.Update(f.ctx, "nope", hook("https://example.com/n")); !errors.Is(err, ErrTargetNotFound) {
		t.Errorf("update of a missing target: %v", err)
	}

	// Turning it on.
	if err := f.s.SetEnabled(f.ctx, added.ID, true); err != nil || !f.get(added.ID).IsEnabled {
		t.Fatalf("enable: %v", err)
	}
	f.changed(1)
	if err := f.s.SetEnabled(f.ctx, "nope", true); !errors.Is(err, ErrTargetNotFound) {
		t.Errorf("switch of a missing target: %v", err)
	}
	if _, err := f.s.Target(f.ctx, "nope"); !errors.Is(err, ErrTargetNotFound) {
		t.Errorf("a missing target: %v", err)
	}

	// Delete, twice.
	if err := f.s.Delete(f.ctx, added.ID); err != nil {
		t.Fatal(err)
	}
	f.changed(1)
	if err := f.s.Delete(f.ctx, added.ID); err != nil {
		t.Fatal(err)
	}
	if !f.quiet(50 * time.Millisecond) {
		t.Error("deleting nothing published a change")
	}
	if list, _ := f.s.Targets(f.ctx); len(list) != 1 || list[0].ID != second.ID {
		t.Fatalf("after delete: %+v", list)
	}
}

// TestTargetsSameMillisecondKeepCreationOrder checks that targets created in the same millisecond
// still list in the order they were created. The ids are random, so they can't break the tie.
func TestTargetsSameMillisecondKeepCreationOrder(t *testing.T) {
	f := newFixture(t)
	var want []string
	for i := range 8 {
		want = append(want, f.create(hook(fmt.Sprintf("https://example.com/hook/%d", i))).ID)
	}
	err := f.db.Write(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE notification_targets SET created_ms = 1`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	list, err := f.s.Targets(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	ids := func(ts []NotificationTarget) []string {
		out := make([]string, 0, len(ts))
		for _, t := range ts {
			out = append(out, t.ID)
		}
		return out
	}
	if got := ids(list); !slices.Equal(got, want) {
		t.Errorf("Targets order = %v, want %v", got, want)
	}
	subscribed, _, err := f.s.subscribed(context.Background(), NotificationEventJobFailed)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(subscribed); !slices.Equal(got, want) {
		t.Errorf("subscribed order = %v, want %v", got, want)
	}
}

func TestTargetRefusals(t *testing.T) {
	f := newFixture(t)
	f.create(hook("https://example.com/hook"))
	mail := f.create(TargetInput{Provider: NotificationProviderEmail, Name: "Ops", URL: "ops@example.com, alice@example.com",
		Events: []NotificationEvent{NotificationEventJobFailed}})
	other := f.create(TargetInput{Provider: NotificationProviderEmail, Name: "Other", URL: "other@example.com",
		Events: []NotificationEvent{NotificationEventJobFailed}})
	bot := TargetInput{Provider: NotificationProviderTelegram, Name: "Bot", URL: "https://api.telegram.org/bot1:a/sendMessage?chat_id=42",
		Events: []NotificationEvent{NotificationEventJobFailed}}
	f.create(bot)

	for _, c := range []struct {
		name  string
		save  func() error
		field string
		msg   string
	}{
		{"the same url, another case", func() error {
			_, err := f.s.Create(f.ctx, hook("  HTTPS://EXAMPLE.COM/HOOK "))
			return err
		}, "url", "A webhook with this URL is already configured."},
		{"the same addresses", func() error {
			_, err := f.s.Create(f.ctx, TargetInput{Provider: NotificationProviderEmail, Name: "Again",
				URL: " OPS@example.com, alice@example.com ", Events: []NotificationEvent{NotificationEventJobFailed}})
			return err
		}, "url", "An email notification to these addresses is already configured."},
		{"an edit onto taken addresses", func() error {
			_, err := f.s.Update(f.ctx, other.ID, TargetInput{Name: "Other", URL: "ops@example.com, alice@example.com",
				Events: []NotificationEvent{NotificationEventJobFailed}})
			return err
		}, "url", "An email notification to these addresses is already configured."},
		{"the same bot and chat", func() error {
			_, err := f.s.Create(f.ctx, bot)
			return err
		}, "url", "This bot already sends to this chat."},
		{"an unknown event", func() error {
			_, err := f.s.Create(f.ctx, hook("https://example.com/new", "schedule.completed"))
			return err
		}, "events", `"schedule.completed" is not a notification event.`},
		{"a bad url", func() error {
			_, err := f.s.Create(f.ctx, TargetInput{Provider: NotificationProviderSlack, Name: "S", URL: "https://example.com",
				Events: []NotificationEvent{NotificationEventJobFailed}})
			return err
		}, "url", "This doesn't look like a Slack webhook URL. Expected https://hooks.slack.com/services/…"},
	} {
		err := c.save()
		var ae *errs.FieldError
		if !errors.As(err, &ae) || ae.Field != c.field || ae.Message != c.msg {
			t.Errorf("%s: %v, want %s: %s", c.name, err, c.field, c.msg)
		}
	}
	// A target's own url doesn't count as a duplicate.
	if _, err := f.s.Update(f.ctx, mail.ID, TargetInput{Name: "Ops!", URL: "OPS@example.com, alice@example.com",
		Events: []NotificationEvent{NotificationEventJobFailed}}); err != nil {
		t.Errorf("an update keeping its url: %v", err)
	}
	if list, _ := f.s.Targets(f.ctx); len(list) != 4 {
		t.Errorf("refusals saved something: %d targets", len(list))
	}

}
