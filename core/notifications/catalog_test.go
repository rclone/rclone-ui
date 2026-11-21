package notifications

import (
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

func TestCatalog(t *testing.T) {
	c := (&Service{}).Catalog()
	var ids []NotificationEvent
	for _, e := range c.Events {
		ids = append(ids, e.ID)
		if !slices.ContainsFunc(c.Categories, func(cat NotificationCategoryMeta) bool { return cat.ID == e.Category }) {
			t.Errorf("%s: category %q is not in the catalog", e.ID, e.Category)
		}
		switch e.Severity {
		case NotificationSeverityInfo, NotificationSeveritySuccess, NotificationSeverityError:
		default:
			t.Errorf("%s: severity %q", e.ID, e.Severity)
		}
		if e.Label == "" || e.Description == "" {
			t.Errorf("%s: no label or description", e.ID)
		}
	}
	want := []NotificationEvent{"job.started", "job.completed", "job.failed", "watcher.failed", "mount.failed", "serve.failed", "app.crashed", "app.update-available"}
	if !slices.Equal(ids, want) {
		t.Errorf("ids = %v, want %v", ids, want)
	}
	for _, cat := range c.Categories {
		if !slices.ContainsFunc(c.Events, func(e NotificationEventMeta) bool { return e.Category == cat.ID }) {
			t.Errorf("category %s has no events", cat.ID)
		}
	}
	for _, e := range []NotificationEvent{"test", "schedule.failed", "workflow.failed", "rclone.update-available"} {
		if _, ok := lookup(e); ok {
			t.Errorf("%s is in the catalog", e)
		}
	}
	c.Events[0].Label = "changed"
	if events[0].label.String() == "changed" {
		t.Error("Catalog hands out the catalog itself")
	}
}

func TestCatalogLocalized(t *testing.T) {
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	c := (&Service{}).Catalog()
	pseudo := func(s string) bool { return strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") }
	for _, cat := range c.Categories {
		if !pseudo(cat.Label) {
			t.Errorf("category %s: %q is not translated", cat.ID, cat.Label)
		}
	}
	for _, e := range c.Events {
		if !pseudo(e.Label) || !pseudo(e.Description) {
			t.Errorf("event %s: %q, %q are not translated", e.ID, e.Label, e.Description)
		}
	}
	if meta, _ := lookup(NotificationEventJobFailed); !pseudo(meta.Label) {
		t.Errorf("a notification's title %q is not translated", meta.Label)
	}
}
