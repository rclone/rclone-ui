import { t } from '@lingui/core/macro'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { notifications as api } from './core/api'
import { coreKey } from './core/query'
import {
    type NotificationCatalog,
    type NotificationEvent,
    NotificationProvider,
    type NotificationTarget,
    SMTPEncryption,
    type SMTPInput,
    type SMTPView,
    type TargetInput,
    type TestInput,
} from './shell/bindings/github.com/rclone/rclone-ui/core/notifications/models'

export type {
    NotificationCatalog,
    NotificationEvent,
    NotificationTarget,
    SMTPInput,
    SMTPView,
    TargetInput,
}
export { NotificationProvider, SMTPEncryption }

// Notifications run in the core (core/notifications): it owns the catalog, the targets, delivery
// and the result of each send, and it validates what is saved. notifications.changed keeps the
// queries fresh. This file has the calls to the core and the helpers for the provider forms.

/** The saved targets, oldest first. */
export function useNotificationTargets() {
    return useQuery({
        queryKey: coreKey('notifications', 'ListTargets'),
        queryFn: () => api.ListTargets(),
    })
}

/** The choices that a target's form offers, in order. */
export function useNotificationsCatalog() {
    return useQuery({
        queryKey: coreKey('notifications', 'Catalog'),
        queryFn: () => api.Catalog(),
    })
}

/**
 * Saves a new target. If the core rejects it (for example, because the address is taken), the
 * error names the field (refusedFields).
 */
export function addNotificationTarget(target: TargetInput): Promise<NotificationTarget> {
    return api.CreateTarget(target)
}

/**
 * Replaces a saved target's name, url, events and enabled state. Its provider stays the same.
 */
export async function updateNotificationTarget(id: string, target: TargetInput): Promise<void> {
    await api.UpdateTarget(id, target)
}

export async function setNotificationTargetEnabled(id: string, enabled: boolean): Promise<void> {
    await api.SetTargetEnabled(id, enabled)
}

export async function removeNotificationTarget(id: string): Promise<void> {
    await api.DeleteTarget(id)
}

/**
 * Sends a test to a saved target, which records the result, or to the provider and url of the
 * unsaved form. Throws with the reason when the test wasn't delivered. The reason is shown to the
 * user: the core gives it in the app's language.
 */
export async function sendTestNotification(target: TestInput): Promise<void> {
    const res = await api.Test(target)
    if (!res.ok) throw new Error(res.message || t`The test notification was not delivered.`)
}

/** The saved mail server, without its password. An empty host means there is none. */
export function useSmtp() {
    return useQuery({ queryKey: coreKey('notifications', 'GetSmtp'), queryFn: () => api.GetSmtp() })
}

/**
 * Saves the mail server. An empty host clears it, and the password is stored in the keychain. If
 * the core rejects the input, the error names the field (refusedFields).
 */
export async function saveSmtp(input: SMTPInput): Promise<void> {
    await api.SetSmtp(input)
}

/** Sends a test mail to `to` through the saved server. Throws with the reason when it fails. */
export async function testSmtp(to: string): Promise<string> {
    const res = await api.TestSmtp(to)
    if (!res.ok) throw new Error(res.message || t`The test mail was not sent.`)
    return res.message ?? ''
}

const P = NotificationProvider

interface ProviderMeta {
    // The provider's name, which is the same in every language.
    label: string
    // addLabel is the title of the drawer that adds a target and the label of its save button.
    // editLabel is the title of the drawer that edits one. Each is a whole label, so that a
    // language can order its words its own way.
    addLabel: string
    editLabel: string
    description: string
    urlPlaceholder: string
    accentClass: string
    // The official docs page for getting the webhook or bot token, shown as a button in the drawer.
    helpUrl?: string
    helpLabel?: string
}

const WEBHOOK: ProviderMeta = {
    label: 'Webhook',
    addLabel: t`Add Webhook`,
    editLabel: t`Edit Webhook`,
    description: t`Post JSON to any endpoint`,
    urlPlaceholder: 'https://example.com/hooks/rclone',
    accentClass: 'text-primary',
}

const PROVIDER_META: Partial<Record<NotificationProvider, ProviderMeta>> = {
    [P.NotificationProviderDiscord]: {
        label: 'Discord',
        addLabel: t`Add Discord Webhook`,
        editLabel: t`Edit Discord Webhook`,
        description: t`Post to a Discord channel`,
        urlPlaceholder: 'https://discord.com/api/webhooks/1234567890/AbCdEf...',
        accentClass: 'text-[#5865F2]',
        helpUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
        helpLabel: t`How to create a webhook`,
    },
    [P.NotificationProviderSlack]: {
        label: 'Slack',
        addLabel: t`Add Slack Webhook`,
        editLabel: t`Edit Slack Webhook`,
        description: t`Post to a Slack channel`,
        urlPlaceholder: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX',
        accentClass: 'text-emerald-500',
        helpUrl: 'https://api.slack.com/messaging/webhooks',
        helpLabel: t`How to create a webhook`,
    },
    [P.NotificationProviderTelegram]: {
        label: 'Telegram',
        addLabel: t`Add Telegram Bot`,
        editLabel: t`Edit Telegram Bot`,
        description: t`Message a chat via your bot`,
        urlPlaceholder: '123456789:AAH…',
        accentClass: 'text-sky-500',
        helpUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
        helpLabel: t`How to create a bot and get its token`,
    },
    [P.NotificationProviderWebhook]: WEBHOOK,
    // The `url` holds the recipients. The mail is sent through the mail server set in the
    // Notifications window.
    [P.NotificationProviderEmail]: {
        label: 'Email',
        addLabel: t`Add Email`,
        editLabel: t`Edit Email`,
        description: t`Send an email through your SMTP server`,
        urlPlaceholder: 'alerts@example.com, ops@example.com',
        accentClass: 'text-amber-500',
    },
}

/** The providers a target can send to, in the order the page offers them. */
export const NOTIFICATION_PROVIDERS: NotificationProvider[] = [
    P.NotificationProviderDiscord,
    P.NotificationProviderSlack,
    P.NotificationProviderTelegram,
    P.NotificationProviderWebhook,
    P.NotificationProviderEmail,
]

export function providerMeta(provider: NotificationProvider): ProviderMeta {
    return PROVIDER_META[provider] ?? WEBHOOK
}

// The checks below are loose, and run while the user types in the form. They catch a field left
// empty, or a value that is plainly not a URL or an address. The core decides what may be saved,
// and when it rejects a save, the reason is shown next to the field (refusedFields).

// The stored URL's path: /bot<token>/sendMessage.
const RE_TELEGRAM_PATH = /^\/bot([^/]+)\/sendMessage$/
const TELEGRAM_API = 'https://api.telegram.org'

// One mailbox: some text, an @, and a domain. It accepts everything that the core accepts,
// including a domain with no dot, as in ops@mailhost.
const RE_EMAIL_ADDRESS = /^[^\s@,<>]+@[^\s@,<>]+$/

/** Checks the Email target's recipients: one address or several, separated by commas. */
function validateRecipients(value: string): string | null {
    const addresses = value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
    if (addresses.length === 0 || addresses.some((address) => !RE_EMAIL_ADDRESS.test(address))) {
        return t`Enter one or more email addresses, separated by commas.`
    }
    return null
}

function isWebUrl(value: string): boolean {
    try {
        const parsed = new URL(value)
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.host
    } catch {
        return false
    }
}

/**
 * Returns what is plainly wrong with a target's url as typed: it is empty, or it isn't a URL (or,
 * for Email, an address).
 */
export function validateWebhookUrl(provider: NotificationProvider, url: string): string | null {
    const trimmed = url.trim()
    if (provider === P.NotificationProviderEmail) {
        return validateRecipients(trimmed)
    }
    if (!trimmed) {
        return t`A webhook URL is required`
    }
    if (!isWebUrl(trimmed)) {
        return t`Enter a URL that starts with https:// or http://`
    }
    return null
}

export const TELEGRAM_CHAT_ID_HELP = t({
    message:
        'Message @userinfobot on Telegram for your own ID, add @getidsbot to a group for its ID, or use @channelname for a public channel.',
    comment:
        '@userinfobot and @getidsbot are the names of Telegram bots: keep them as they are. @channelname is an example.',
})

/**
 * Builds the stored Telegram URL from the bot token that BotFather sent and the chat id. The
 * target stores one URL (https://api.telegram.org/bot<token>/sendMessage?chat_id=…), so that
 * delivery works the same way for every provider, and the form edits its two parts.
 */
export function buildTelegramUrl(token: string, chatId: string): string {
    return `${TELEGRAM_API}/bot${token.trim()}/sendMessage?chat_id=${encodeURIComponent(chatId.trim())}`
}

/** The inverse of buildTelegramUrl, for filling in the edit form from a stored URL. */
export function splitTelegramUrl(url: string): { token: string; chatId: string } {
    try {
        const parsed = new URL(url)
        const token = RE_TELEGRAM_PATH.exec(parsed.pathname)?.[1] ?? ''
        return {
            token: decodeURIComponent(token),
            chatId: parsed.searchParams.get('chat_id') ?? '',
        }
    } catch {
        return { token: '', chatId: '' }
    }
}

/**
 * The core's errors for a target's form, by field (notifications.Check). The previous answer
 * stays while a new one loads. For Telegram, the `url` error is about the bot token and the
 * `chatId` error is about the chat ID. A url that another target already uses is only rejected
 * by a save. Returns undefined while `input` is undefined.
 */
export function useTargetProblems(
    input: TargetInput | undefined
): Record<string, string> | undefined {
    const key = input ? JSON.stringify(input) : ''
    const [asked] = useDebounce(key, 400)
    const query = useQuery({
        queryKey: coreKey('notifications', 'Check', asked),
        queryFn: async () => (await api.Check(JSON.parse(asked) as TargetInput)) ?? {},
        enabled: asked !== '',
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        placeholderData: keepPreviousData,
    })
    if (!input) return undefined
    return query.data as Record<string, string> | undefined
}

const MAX_MASK_SEGMENT_LENGTH = 10

/**
 * What the list shows under a target's name: its recipients in full, the bot and the chat for
 * Telegram (the bot's number is the public part of its token), or its URL masked.
 */
export function targetSubtitle(target: Pick<NotificationTarget, 'provider' | 'url'>): string {
    if (target.provider === P.NotificationProviderEmail) return target.url
    if (target.provider === P.NotificationProviderTelegram) {
        const { token, chatId } = splitTelegramUrl(target.url)
        const bot = token.split(':')[0]
        if (bot && chatId) return t`Bot ${bot} → chat ${chatId}`
    }
    return maskWebhookUrl(target.url)
}

// Webhook URLs are credentials (Telegram's first path segment IS the bot token), so the list
// shows this masked form instead of the full URL.
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
