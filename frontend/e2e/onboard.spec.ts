import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { collectErrors, runToExit } from './helpers'

// The first launch: a server started without --email/--password has no account, so its first
// visitor creates the owner's at /onboard. The 5618 server is the one started that way; the tests
// run in this order, and the last two find the account the third created.

const base = 'http://127.0.0.1:5618'
const OWNER = { email: 'first@example.com', password: 'first-secret-1' }

test('with no account, every door leads to /onboard', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: base })
    try {
        const session = await (await context.request.get('/api/session')).json()
        expect(session).toMatchObject({ authenticated: false, onboard: true })
        const page = await context.newPage()
        const errors = collectErrors(page)
        await page.goto('/')
        await expect(page).toHaveURL(/\/onboard$/)
        await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible()
        await page.goto('/login')
        await expect(page).toHaveURL(/\/onboard$/)
        expect(errors).toEqual([])
    } finally {
        await context.close()
    }
})

test('mismatched passwords never leave the page; a short one is refused by the server', async ({
    browser,
}) => {
    const context = await browser.newContext({ baseURL: base })
    try {
        const page = await context.newPage()
        await page.goto('/onboard')
        await page.getByLabel('Email').fill(OWNER.email)
        await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
        await page.getByLabel('Confirm password').fill('something-else-1')
        await page.getByRole('button', { name: 'Create account' }).click()
        await expect(page.getByRole('alert')).toHaveText('The passwords do not match')
        await page.getByLabel('Password', { exact: true }).fill('short')
        await page.getByLabel('Confirm password').fill('short')
        await page.getByRole('button', { name: 'Create account' }).click()
        await expect(page.getByRole('alert')).toContainText('at least 8 characters')
        expect((await (await context.request.get('/api/session')).json()).onboard).toBe(true)
    } finally {
        await context.close()
    }
})

test('creating the owner signs in and lands on the Dashboard, once', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: base })
    try {
        const page = await context.newPage()
        const errors = collectErrors(page)
        await page.goto('/onboard')
        await page.getByLabel('Email').fill(OWNER.email)
        await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
        await page.getByLabel('Confirm password').fill(OWNER.password)
        await page.getByRole('button', { name: 'Create account' }).click()
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
        const session = await (await context.request.get('/api/session')).json()
        expect(session).toMatchObject({
            authenticated: true,
            onboard: false,
            user: { email: OWNER.email, role: 'owner' },
        })
        // A tab that comes late is refused, and the screen now leads into the app.
        const again = await context.request.post('/api/onboard', {
            data: { email: 'second@example.com', password: 'second-secret-1' },
        })
        expect(again.status()).toBe(409)
        await page.goto('/onboard')
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
        expect(errors).toEqual([])
    } finally {
        await context.close()
    }
})

test('once the owner exists, a fresh visitor gets the login and the account works', async ({
    browser,
}) => {
    const context = await browser.newContext({ baseURL: base })
    try {
        const page = await context.newPage()
        await page.goto('/onboard')
        await expect(page).toHaveURL(/\/login$/)
        await page.getByLabel('Email').fill(OWNER.email)
        await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    } finally {
        await context.close()
    }
})

test('--email or --password alone stops the server before it listens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-pair-'))
    try {
        const alone = [
            { args: ['--password', 'lonely-secret'], needs: '--email' },
            { args: ['--email', 'lonely@example.com'], needs: '--password' },
        ]
        for (const { args, needs } of alone) {
            const { code, stderr } = await runToExit([...args, '--data-dir', join(root, 'data')])
            expect(code).toBe(1)
            expect(stderr).toContain(`needs ${needs}`)
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
