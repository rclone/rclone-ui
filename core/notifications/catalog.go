package notifications

import "github.com/rclone/rclone-ui/core/i18n"

type category struct {
	ID    NotificationCategory
	label i18n.Text
}

type event struct {
	ID                 NotificationEvent
	label, description i18n.Text
	Category           NotificationCategory
	Severity           NotificationSeverity
}

func (e event) meta() NotificationEventMeta {
	return NotificationEventMeta{
		ID: e.ID, Label: e.label.Local(), Description: e.description.Local(),
		Category: e.Category, Severity: e.Severity,
	}
}

var categories = []category{
	// i18n: A group of notification events, in the Notifications window.
	{NotificationCategoryTransfers, i18n.M("Transfers")},
	// i18n: A group of notification events, in the Notifications window.
	{NotificationCategoryMounts, i18n.M("Mounts & serves")},
	// i18n: A group of notification events, in the Notifications window: the app itself.
	{NotificationCategorySystem, i18n.M("System")},
}

var events = []event{
	{
		ID: NotificationEventJobStarted,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Transfer started"),
		description: i18n.M("A copy, move, sync, bisync, delete or purge job was started manually"),
		Category:    NotificationCategoryTransfers,
		Severity:    NotificationSeverityInfo,
	},
	{
		ID: NotificationEventJobCompleted,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Transfer completed"),
		description: i18n.M("A job finished successfully, whether you or a schedule started it"),
		Category:    NotificationCategoryTransfers,
		Severity:    NotificationSeveritySuccess,
	},
	{
		ID: NotificationEventJobFailed,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Transfer failed"),
		description: i18n.M("A job finished with errors, whether you or a schedule started it"),
		Category:    NotificationCategoryTransfers,
		Severity:    NotificationSeverityError,
	},
	{
		ID: NotificationEventWatcherFailed,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Watcher failed"),
		description: i18n.M("A watcher could not keep its two folders the same"),
		Category:    NotificationCategoryTransfers,
		Severity:    NotificationSeverityError,
	},
	{
		ID: NotificationEventMountFailed,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Mount failed"),
		description: i18n.M("A remote could not be mounted"),
		Category:    NotificationCategoryMounts,
		Severity:    NotificationSeverityError,
	},
	{
		ID: NotificationEventServeFailed,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Serve failed"),
		description: i18n.M("A serve stopped unexpectedly"),
		Category:    NotificationCategoryMounts,
		Severity:    NotificationSeverityError,
	},
	{
		ID: NotificationEventAppCrashed,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Rclone UI crashed"),
		description: i18n.M("The app quit unexpectedly, and was started again"),
		Category:    NotificationCategorySystem,
		Severity:    NotificationSeverityError,
	},
	{
		ID: NotificationEventUpdateAvailable,
		// i18n: A notification event, and the title of its notification.
		label:       i18n.M("Update available"),
		description: i18n.M("A new version of Rclone UI is available"),
		Category:    NotificationCategorySystem,
		Severity:    NotificationSeverityInfo,
	},
}

var testEvent = event{
	ID: "test",
	// i18n: The title of the notification that "Send Test" sends.
	label:       i18n.M("Test notification"),
	description: i18n.M("A test notification, sent from the Notifications window"),
	Severity:    NotificationSeverityInfo,
}

func lookup(id NotificationEvent) (NotificationEventMeta, bool) {
	for _, e := range events {
		if e.ID == id {
			return e.meta(), true
		}
	}
	return NotificationEventMeta{}, false
}

func (s *Service) Catalog() NotificationCatalog {
	c := NotificationCatalog{
		Categories: make([]NotificationCategoryMeta, len(categories)),
		Events:     make([]NotificationEventMeta, len(events)),
	}
	for i, cat := range categories {
		c.Categories[i] = NotificationCategoryMeta{ID: cat.ID, Label: cat.label.Local()}
	}
	for i, e := range events {
		c.Events[i] = e.meta()
	}
	return c
}
