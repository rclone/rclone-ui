// Mirrors src-shared/src/notifications/catalog.rs (event ids/categories/severities) and
// targets.rs (NotificationTarget shape, persisted in notifications/targets.json). The Rust side
// is the source of truth — keep both in sync, and never rename an event id after release. An
// `email` target's `url` is its recipients (comma-separated); it is sent through the SMTP
// settings (smtp.rs, `types/smtp.d.ts`).

export type NotificationEventId =
    | 'job.started'
    | 'job.completed'
    | 'job.failed'
    | 'schedule.started'
    | 'schedule.completed'
    | 'schedule.failed'
    | 'mount.failed'
    | 'rclone.crashed'
    | 'rclone.update-available'
    | 'app.update-available'

export type NotificationSeverity = 'info' | 'success' | 'error'
export type NotificationCategory = 'transfers' | 'schedules' | 'system'

export type NotificationProvider = 'discord' | 'slack' | 'telegram' | 'webhook' | 'email'

export interface NotificationEventMeta {
    id: NotificationEventId
    label: string
    description: string
    category: NotificationCategory
    severity: NotificationSeverity
}

/** Returned by the `notifications_catalog` command. */
export interface NotificationCatalog {
    categories: { id: NotificationCategory; label: string }[]
    events: NotificationEventMeta[]
}

export interface NotificationTarget {
    id: string
    provider: NotificationProvider
    name: string
    url: string
    isEnabled: boolean
    events: NotificationEventId[]
    createdAt: number
    // Delivery status, written by the dispatcher after each send attempt.
    lastSentAt?: number
    lastError?: string
}
