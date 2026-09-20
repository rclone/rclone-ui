import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { SESSION, smtpReceiver, stopLeftoverJobs } from './helpers'

// Notifications: an email goes out through the SMTP settings.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

test('an email notification goes out through the SMTP settings', async ({ page, request }) => {
    // Email is a provider like the others: a target with a name and its recipients, its events,
    // Send Test, and a delivery record. What differs is the way out: the mail server saved on
    // the SMTP screen, read by the server at the moment it sends.
    const mail = await smtpReceiver()
    const rpc = async (name: string, data: Record<string, unknown> = {}) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    const settings = (host: string, port: number) => ({
        host,
        port,
        encryption: 'none',
        username: '',
        password: null,
        fromAddress: 'rclone-cloud@example.com',
        fromName: 'Rclone Cloud e2e',
    })
    const saved = await rpc('smtp_set', { settings: settings(mail.host, mail.port) })
    expect(saved.error).toBeUndefined()
    let targetId: string | undefined
    try {
        await page.goto('/settings/notifications')
        await page.locator('[data-provider="email"]').click()
        await expect(page.getByRole('dialog', { name: 'Add Email' })).toBeVisible()
        await expect(page.getByText('Set up SMTP first')).toHaveCount(0)
        await page.getByLabel('Name', { exact: true }).fill('Ops')
        await page.getByLabel('Send to', { exact: true }).fill('ops@example.com, alice@example.com')
        await page.getByRole('button', { name: 'Add Email' }).click()

        // The card names the recipients in full: they are addresses, not a credential to mask.
        const card = page.locator('[data-target]', { hasText: 'Ops' })
        await expect(card).toBeVisible()
        await expect(card.getByText('ops@example.com, alice@example.com')).toBeVisible()
        targetId = await card.getAttribute('data-target')

        await card.locator('button:has(svg.lucide-settings)').click()
        await page.getByRole('menuitem', { name: 'Send Test' }).click()
        await expect(page.getByText('Test notification sent successfully.')).toBeVisible()
        await page.getByRole('button', { name: 'Ok', exact: true }).click()
        expect(mail.received).toHaveLength(1)
        const [sent] = mail.received
        expect(sent.from).toBe('rclone-cloud@example.com')
        expect(sent.to).toEqual(['ops@example.com', 'alice@example.com'])
        expect(sent.message).toContain('Subject: Test notification')
        expect(sent.message).toMatch(/^From: .*Rclone Cloud e2e.*<rclone-cloud@example.com>/m)
        expect(sent.message).toContain('This is a test notification from Rclone Cloud for "Ops".')
        // The footer's dash travels quoted-printable, as any mail client reads it back.
        expect(sent.message).toContain('=E2=80=94 Rclone Cloud v')
        await expect(card.locator('svg.text-warning')).toHaveCount(0)

        // A server that does not answer: the test says so, and the card wears the warning.
        const closed = createServer()
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()))
        const deadPort = (closed.address() as { port: number }).port
        await new Promise<void>((resolve) => closed.close(() => resolve()))
        await rpc('smtp_set', { settings: settings('127.0.0.1', deadPort) })
        await card.locator('button:has(svg.lucide-settings)').click()
        await page.getByRole('menuitem', { name: 'Send Test' }).click()
        await expect(page.getByRole('dialog').getByText('Test failed')).toBeVisible()
        await page.getByRole('button', { name: 'Ok', exact: true }).click()
        await expect(card.locator('svg.text-warning')).toBeVisible()
        expect(mail.received).toHaveLength(1)
    } finally {
        if (targetId) await rpc('notifications_remove_target', { id: targetId })
        await rpc('smtp_set', { settings: { ...settings('', 0), encryption: 'starttls' } })
        mail.close()
    }
})
