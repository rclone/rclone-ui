package notifications

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
)

// TestLastErrorIsSaved checks that a delivery's error is saved in its translatable form, that the
// service reads it back in English, and that the API gives it in the app's language.
func TestLastErrorIsSaved(t *testing.T) {
	f := newFixture(t)
	target := f.create(hook("https://example.com/hook", NotificationEventJobStarted))
	f.hooks.set(func(int, *http.Request) (int, error) { return 404, nil })
	f.s.Notify(system, NotificationEventJobStarted, Job{Operation: "copy"})
	f.changed(1)

	var saved sql.NullString
	if err := f.db.Read(f.ctx, func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT last_error FROM notification_targets WHERE id = ?`, target.ID).Scan(&saved)
	}); err != nil {
		t.Fatal(err)
	}
	if i18n.Saved(saved.String).String() != "Webhook responded with status 404" || saved.String == "Webhook responded with status 404" {
		t.Fatalf("saved %q, want the error's saved form", saved.String)
	}
	if got := f.get(target.ID); got.LastError != "Webhook responded with status 404" {
		t.Fatalf("the service reads %q", got.LastError)
	}
	api := NewAPI(late.Of(f.s))
	list, err := api.ListTargets(f.ctx)
	if err != nil || len(list) != 1 || list[0].LastError != "Webhook responded with status 404" {
		t.Fatalf("the API lists %+v, %v", list, err)
	}

	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	list, err = api.ListTargets(f.ctx)
	if err != nil || len(list) != 1 || !strings.HasPrefix(list[0].LastError, "[") || !strings.Contains(list[0].LastError, "404") {
		t.Fatalf("the API lists %+v in the pseudo-language, %v", list, err)
	}
}

// TestMessages checks the bodies that are built from parts: the sources of a job, with a plural
// for the ones left out, and the crashes of the app.
func TestMessages(t *testing.T) {
	for _, c := range []struct {
		p     Payload
		event NotificationEvent
		title string
		body  string
	}{
		{Job{Operation: "copy", Sources: []string{"a:", "b:", "c:"}, Destination: "d:"}, NotificationEventJobStarted,
			"Transfer started", "copy of a:, b: and 1 more to d:"},
		{Job{Operation: "move", Sources: []string{"a:", "b:", "c:", "e:"}, Destination: "d:"}, NotificationEventJobStarted,
			"Transfer started", "move of a:, b: and 2 more to d:"},
		{Job{Operation: "purge", Sources: []string{"a:old"}, Error: "boom", Schedule: "Nightly"}, NotificationEventJobFailed,
			"Transfer failed", "Nightly: purge of a:old — boom"},
		{Job{Operation: "copy", Destination: "d:"}, NotificationEventJobCompleted, "Transfer completed", "copy to d:"},
		{Job{Operation: "copy"}, NotificationEventJobCompleted, "Transfer completed", "copy"},
		{Crashed{Crashes: 1}, NotificationEventAppCrashed, "Rclone UI crashed", "Rclone UI quit unexpectedly and was started again."},
		{Crashed{Crashes: 3, Error: "signal: killed"}, NotificationEventAppCrashed, "Rclone UI crashed",
			"Rclone UI quit unexpectedly 3 times in a row and was started again. signal: killed"},
		{MountFailed{Source: "a:", Destination: "/mnt/a", Skipped: true}, NotificationEventMountFailed, "Automount skipped",
			"a: is not reachable (network or sign-in problem) — not mounting to avoid an empty folder at /mnt/a"},
	} {
		if title, body := c.p.Message(c.event); title != c.title || body != c.body {
			t.Errorf("%+v: %q, %q, want %q, %q", c.p, title, body, c.title, c.body)
		}
	}

	// In another language, the whole message is translated, with the values in it.
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	title, body := Job{Operation: "sync", Sources: []string{"a:"}, Destination: "d:"}.Message(NotificationEventJobCompleted)
	if !strings.HasPrefix(title, "[") || !strings.HasPrefix(body, "[") || !strings.Contains(body, "a:") || !strings.Contains(body, "d:") {
		t.Errorf("in the pseudo-language: %q, %q", title, body)
	}
}
