import { expect, test, vi } from 'vitest'
import {
    buildTelegramUrl,
    NotificationProvider,
    splitTelegramUrl,
    targetSubtitle,
    validateWebhookUrl,
} from './notifications'

vi.mock('./core/api', () => ({ notifications: {} }))

const P = NotificationProvider

test('recipients are checked no stricter than the core checks them', () => {
    for (const ok of ['ops@example.com', 'ops@mailhost', ' a@x.org , b@mailhost ']) {
        expect(validateWebhookUrl(P.NotificationProviderEmail, ok)).toBeNull()
    }
    for (const bad of [
        '',
        'ops',
        'ops@',
        '@mailhost',
        'a b@x.org',
        'Ops <ops@x.org>',
        'a@x.org;b@x.org',
    ]) {
        expect(validateWebhookUrl(P.NotificationProviderEmail, bad)).not.toBeNull()
    }
})

test('a webhook url is only checked to be one: the core says whether it suits the provider', () => {
    expect(validateWebhookUrl(P.NotificationProviderDiscord, 'https://example.com/x')).toBeNull()
    expect(validateWebhookUrl(P.NotificationProviderWebhook, 'http://localhost:8080')).toBeNull()
    for (const bad of ['', '   ', 'discord.com/api/webhooks/1/x', 'ftp://example.com']) {
        expect(validateWebhookUrl(P.NotificationProviderDiscord, bad)).not.toBeNull()
    }
})

test('a Telegram target is the bot token that BotFather sends and a chat id', () => {
    const url = buildTelegramUrl(' 123456789:AAH-x_y ', ' -1001234567890 ')
    expect(url).toBe(
        'https://api.telegram.org/bot123456789:AAH-x_y/sendMessage?chat_id=-1001234567890'
    )
    expect(splitTelegramUrl(url)).toEqual({ token: '123456789:AAH-x_y', chatId: '-1001234567890' })
    expect(splitTelegramUrl(buildTelegramUrl('1:a', '@my_channel')).chatId).toBe('@my_channel')
})

test('the list shows a Telegram target by its bot and chat, never its secret', () => {
    const url = buildTelegramUrl('123456789:AAH-secret', '-1001234567890')
    const shown = targetSubtitle({ provider: P.NotificationProviderTelegram, url })
    expect(shown).toBe('Bot 123456789 → chat -1001234567890')
    expect(shown).not.toContain('AAH-secret')
})
