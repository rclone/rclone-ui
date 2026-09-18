//! The notification event catalog — the single source of truth for event ids, labels, and
//! severities. types/notifications.d.ts mirrors the id union and lib/notifications.ts renders
//! the drawer checkboxes from `notifications_catalog`; keep all three in sync.
//!
//! Event ids are stable wire strings: they are persisted per-target in targets.json and sent
//! verbatim to generic webhooks. Never rename an id after release.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct EventMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub severity: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct CategoryMeta {
    pub id: &'static str,
    pub label: &'static str,
}

pub const CATEGORIES: [CategoryMeta; 3] = [
    CategoryMeta {
        id: "transfers",
        label: "Transfers",
    },
    CategoryMeta {
        id: "schedules",
        label: "Scheduled Tasks",
    },
    CategoryMeta {
        id: "system",
        label: "System",
    },
];

pub const EVENTS: [EventMeta; 10] = [
    EventMeta {
        id: "job.started",
        label: "Transfer started",
        description: "A copy, move, sync, bisync, delete or purge job was started manually",
        category: "transfers",
        severity: "info",
    },
    EventMeta {
        id: "job.completed",
        label: "Transfer completed",
        description: "A manually started job finished successfully",
        category: "transfers",
        severity: "success",
    },
    EventMeta {
        id: "job.failed",
        label: "Transfer failed",
        description: "A manually started job finished with errors",
        category: "transfers",
        severity: "error",
    },
    EventMeta {
        id: "schedule.started",
        label: "Scheduled task started",
        description: "A scheduled task began running",
        category: "schedules",
        severity: "info",
    },
    EventMeta {
        id: "schedule.completed",
        label: "Scheduled task completed",
        description: "A scheduled task finished successfully",
        category: "schedules",
        severity: "success",
    },
    EventMeta {
        id: "schedule.failed",
        label: "Scheduled task failed",
        description: "A scheduled task failed to start or finished with errors",
        category: "schedules",
        severity: "error",
    },
    EventMeta {
        id: "mount.failed",
        label: "Mount failed",
        description: "A remote could not be mounted",
        category: "system",
        severity: "error",
    },
    EventMeta {
        id: "rclone.crashed",
        label: "Rclone daemon crashed",
        description: "The rclone daemon exited unexpectedly",
        category: "system",
        severity: "error",
    },
    EventMeta {
        id: "rclone.update-available",
        label: "Rclone update available",
        description: "A new rclone version is available",
        category: "system",
        severity: "info",
    },
    EventMeta {
        id: "app.update-available",
        label: "App update available",
        description: "A new Rclone UI version is available",
        category: "system",
        severity: "info",
    },
];

/// The synthetic event used by "Send Test". Not part of EVENTS: it must never appear in the
/// drawer's checkbox list and no target can subscribe to it.
pub const TEST_EVENT: EventMeta = EventMeta {
    id: "test",
    label: "Test notification",
    description: "A test notification sent from the settings screen",
    category: "system",
    severity: "info",
};

pub fn find(id: &str) -> Option<&'static EventMeta> {
    EVENTS.iter().find(|e| e.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_the_ten_wire_stable_ids() {
        let ids: Vec<&str> = EVENTS.iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            vec![
                "job.started",
                "job.completed",
                "job.failed",
                "schedule.started",
                "schedule.completed",
                "schedule.failed",
                "mount.failed",
                "rclone.crashed",
                "rclone.update-available",
                "app.update-available",
            ]
        );
        for event in &EVENTS {
            assert!(CATEGORIES.iter().any(|c| c.id == event.category));
            assert!(matches!(event.severity, "info" | "success" | "error"));
        }
        assert!(
            find("test").is_none(),
            "test event must stay out of the catalog"
        );
    }
}
