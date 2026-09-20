import { addToast } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { rpc } from '@/server/rpc'

// Mirrors src/notifications/catalog.rs (event ids/categories/severities) and
// targets.rs (NotificationTarget shape, persisted in notifications/targets.json). The Rust side
// is the source of truth — keep both in sync, and never rename an event id after release. An
// `email` target's `url` is its recipients (comma-separated); it is sent through the SMTP
// settings (smtp.rs, `lib/smtp.ts`).

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

// The TS face of the notification system. The engine lives in Rust (src/notifications/):
// webhook and email dispatch (email through the SMTP settings, lib/smtp.ts), target storage
// (targets.json — NOT the zustand store), delivery-outcome recording, and the event catalog.
// The server owns all of it, so notifications go out whether or not a page is open. This file
// keeps the thin RPC wrappers and the provider form helpers.

// ---------------------------------------------------------------------------
// In-page toasts
// ---------------------------------------------------------------------------

// The only kind there is: what a person must see is shown by the page they are looking at (or
// leaves over a webhook or email).
export async function notify({ title, body }: { title: string; body: string }) {
    addToast({ title, description: body })
}

// ---------------------------------------------------------------------------
// Webhook engine wrappers
// ---------------------------------------------------------------------------

export type NewNotificationTarget = Omit<
    NotificationTarget,
    'id' | 'createdAt' | 'lastSentAt' | 'lastError'
>

export async function getNotificationsCatalog(): Promise<NotificationCatalog> {
    return await rpc<NotificationCatalog>('notifications_catalog')
}

export async function listNotificationTargets(): Promise<NotificationTarget[]> {
    return await rpc<NotificationTarget[]>('notifications_list_targets')
}

/** Throws with a user-facing message (e.g. duplicate URL — re-checked race-safely in Rust). */
export async function addNotificationTarget(
    target: NewNotificationTarget
): Promise<NotificationTarget> {
    return await rpc<NotificationTarget>('notifications_add_target', { target })
}

export async function updateNotificationTarget(
    id: string,
    patch: Partial<Omit<NotificationTarget, 'id' | 'createdAt' | 'lastSentAt' | 'lastError'>>
): Promise<void> {
    await rpc('notifications_update_target', { id, patch })
}

export async function removeNotificationTarget(id: string): Promise<void> {
    await rpc('notifications_remove_target', { id })
}

/**
 * Sends `eventId` to every enabled webhook target that subscribed to it. Fire-and-forget for
 * callers (never throws); delivery happens in Rust, which records lastSentAt/lastError per
 * target and reads targets at fire time.
 */
/**
 * Sends a test payload directly to the given target (which may be unsaved drawer values).
 * Throws on failure so the UI can surface the error; Rust records the outcome when the target
 * already exists (`id` set).
 */
export async function sendTestNotification(
    target: Pick<NotificationTarget, 'provider' | 'url'> & { id?: string; name?: string }
): Promise<void> {
    await rpc('notifications_send_test', {
        provider: target.provider,
        url: target.url,
        targetId: target.id,
        name: target.name,
    })
}

export function useNotificationTargets() {
    return useQuery({
        queryKey: ['notifications', 'targets'],
        queryFn: listNotificationTargets,
        // Dispatches (and their outcome recording) happen in the server, with no page involved,
        // so nothing invalidates this window's cache. Polling is what keeps the
        // lastSentAt/lastError chips honest.
        refetchInterval: 10_000,
        refetchOnWindowFocus: true,
    })
}

export function useNotificationsCatalog() {
    return useQuery({
        queryKey: ['notifications', 'catalog'],
        queryFn: getNotificationsCatalog,
        // Default staleTime, NOT Infinity: lib/query.ts persists the cache to localStorage for
        // 30 days, and a frozen catalog would hide events added by app updates.
    })
}

// ---------------------------------------------------------------------------
// Provider form helpers
// ---------------------------------------------------------------------------

export const NOTIFICATION_PROVIDERS: Record<
    NotificationProvider,
    {
        label: string
        // Noun used in drawer titles/buttons, e.g. "Add Discord Webhook" / "Add Telegram Bot".
        titleLabel: string
        description: string
        urlPlaceholder: string
        accentClass: string
        // Official docs page for obtaining the webhook/bot token, shown as a button in the drawer.
        helpUrl?: string
        helpLabel?: string
    }
> = {
    discord: {
        label: 'Discord',
        titleLabel: 'Discord Webhook',
        description: 'Post to a Discord channel',
        urlPlaceholder: 'https://discord.com/api/webhooks/1234567890/AbCdEf...',
        accentClass: 'text-[#5865F2]',
        helpUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
        helpLabel: 'How to create a webhook',
    },
    slack: {
        label: 'Slack',
        titleLabel: 'Slack Webhook',
        description: 'Post to a Slack channel',
        urlPlaceholder: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX',
        accentClass: 'text-emerald-500',
        helpUrl: 'https://api.slack.com/messaging/webhooks',
        helpLabel: 'How to create a webhook',
    },
    telegram: {
        label: 'Telegram',
        titleLabel: 'Telegram Bot',
        description: 'Message a chat via your bot',
        urlPlaceholder: 'https://api.telegram.org/bot123456:ABC-DEF...',
        accentClass: 'text-sky-500',
        helpUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
        helpLabel: 'How to create a bot & get a token',
    },
    webhook: {
        label: 'Webhook',
        titleLabel: 'Webhook',
        description: 'Post JSON to any endpoint',
        urlPlaceholder: 'https://example.com/hooks/rclone',
        accentClass: 'text-primary',
    },
    // The `url` is the recipients; the way out is the SMTP settings (lib/smtp.ts).
    email: {
        label: 'Email',
        titleLabel: 'Email',
        description: 'Send an email through your SMTP server',
        urlPlaceholder: 'alerts@example.com, ops@example.com',
        accentClass: 'text-amber-500',
    },
}

// Accepts discord.com, legacy discordapp.com, and the ptb./canary. test clients.
const RE_DISCORD_WEBHOOK =
    /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/
const RE_SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/\w+$/
// Standard Bot API endpoint: the path carries "bot<botid>:<token>"; chat_id rides the query.
// This is the STORED shape — the form collects only the pure bot URL (below) and the
// /sendMessage method is appended by buildTelegramUrl.
const RE_TELEGRAM_SEND_MESSAGE = /^https:\/\/api\.telegram\.org\/bot\d+:[\w-]+\/sendMessage(\?.*)?$/
// What the form accepts: the pure bot URL. A pasted full endpoint or trailing slash is
// tolerated (normalized away when the URL is built) rather than rejected.
const RE_TELEGRAM_BOT_URL = /^https:\/\/api\.telegram\.org\/bot\d+:[\w-]+(\/sendMessage)?\/?$/
const RE_TELEGRAM_SEND_MESSAGE_SUFFIX = /\/sendMessage$/
const RE_TRAILING_SLASHES = /\/+$/

// One mailbox: something, an @, a domain with a dot. The server parses it for real before it
// sends; this only keeps a typo from being saved.
const RE_EMAIL_ADDRESS = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/

/** The Email target's recipients: one address or several, separated by commas. */
export function validateRecipients(value: string): string | null {
    const addresses = value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
    if (addresses.length === 0 || addresses.some((address) => !RE_EMAIL_ADDRESS.test(address))) {
        return 'Enter one or more email addresses, separated by commas.'
    }
    return null
}

export function validateWebhookUrl(provider: NotificationProvider, url: string): string | null {
    const trimmed = url.trim()

    if (provider === 'email') {
        return validateRecipients(trimmed)
    }

    if (!trimmed) {
        return 'A webhook URL is required'
    }

    if (provider === 'discord') {
        if (!RE_DISCORD_WEBHOOK.test(trimmed)) {
            return "This doesn't look like a Discord webhook URL — expected https://discord.com/api/webhooks/…"
        }
        return null
    }

    if (provider === 'slack') {
        if (!RE_SLACK_WEBHOOK.test(trimmed)) {
            return "This doesn't look like a Slack webhook URL — expected https://hooks.slack.com/services/…"
        }
        return null
    }

    if (provider === 'telegram') {
        if (!RE_TELEGRAM_SEND_MESSAGE.test(trimmed)) {
            return "This doesn't look like a Telegram Bot API URL — expected https://api.telegram.org/bot<token>/sendMessage"
        }
        const { chatId } = splitTelegramUrl(trimmed)
        if (validateTelegramChatId(chatId)) {
            return 'The Telegram URL is missing a valid chat_id'
        }
        return null
    }

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        return 'This is not a valid URL'
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'The URL must use http:// or https://'
    }

    return null
}

// Integer chat id (negative for groups/supergroups) or a public @channelusername.
const RE_TELEGRAM_CHAT_ID = /^(-?\d+|@\w{5,})$/

export const TELEGRAM_CHAT_ID_HELP =
    'Message @userinfobot on Telegram for your own ID, add @getidsbot to a group for its ID, or use @channelname for a public channel.'

/**
 * The Telegram form collects the pure bot URL and the chat id separately; the /sendMessage
 * method and the chat_id are both OURS to add — they are merged into one stored URL
 * (…/sendMessage?chat_id=…) so the dispatcher and the NotificationTarget shape stay
 * provider-agnostic. The UI never lets users type query params directly.
 */
export function buildTelegramUrl(baseUrl: string, chatId: string): string {
    const parsed = new URL(baseUrl.trim())
    parsed.search = ''
    const base = parsed
        .toString()
        .replace(RE_TRAILING_SLASHES, '')
        .replace(RE_TELEGRAM_SEND_MESSAGE_SUFFIX, '')
    return `${base}/sendMessage?chat_id=${encodeURIComponent(chatId.trim())}`
}

/** Inverse of buildTelegramUrl, for seeding the edit form from a stored URL. */
export function splitTelegramUrl(url: string): { baseUrl: string; chatId: string } {
    try {
        const parsed = new URL(url)
        const chatId = parsed.searchParams.get('chat_id') ?? ''
        parsed.search = ''
        const baseUrl = parsed
            .toString()
            .replace(RE_TRAILING_SLASHES, '')
            .replace(RE_TELEGRAM_SEND_MESSAGE_SUFFIX, '')
        return { baseUrl, chatId }
    } catch {
        return { baseUrl: url, chatId: '' }
    }
}

/** Validates the drawer's Telegram URL field: the pure bot URL, no query params. */
export function validateTelegramBotUrl(url: string): string | null {
    const trimmed = url.trim()
    if (!trimmed) {
        return 'A bot URL is required'
    }
    if (trimmed.includes('?')) {
        return "Don't include query parameters — enter the Chat ID in its own field below"
    }
    if (!RE_TELEGRAM_BOT_URL.test(trimmed)) {
        return "This doesn't look like a Telegram Bot API URL — expected https://api.telegram.org/bot<token>"
    }
    return null
}

export function validateTelegramChatId(chatId: string): string | null {
    const trimmed = chatId.trim()
    if (!trimmed) {
        return 'A chat ID is required'
    }
    if (!RE_TELEGRAM_CHAT_ID.test(trimmed)) {
        return 'Enter a numeric chat ID (negative for groups) or a public @channelname'
    }
    return null
}

const MAX_MASK_SEGMENT_LENGTH = 10

/** What the list shows under a target's name: its recipients in full, or its URL masked. */
export function targetSubtitle(target: Pick<NotificationTarget, 'provider' | 'url'>): string {
    return target.provider === 'email' ? target.url : maskWebhookUrl(target.url)
}

// Webhook URLs are credentials (Telegram's first path segment IS the bot token) — the list view
// renders this instead of the full URL.
export function maskWebhookUrl(url: string): string {
    try {
        const parsed = new URL(url)
        const segments = parsed.pathname.split('/').filter(Boolean)
        if (segments.length === 0) {
            return parsed.host
        }
        const firstSegment =
            segments[0].length > MAX_MASK_SEGMENT_LENGTH
                ? `${segments[0].slice(0, MAX_MASK_SEGMENT_LENGTH)}…`
                : segments[0]
        if (segments.length === 1 && !parsed.search) {
            return `${parsed.host}/${firstSegment}`
        }
        return `${parsed.host}/${firstSegment}/…${url.slice(-4)}`
    } catch {
        return url.length > 24 ? `${url.slice(0, 24)}…` : url
    }
}
