import { expect, test } from '@playwright/test'
import { OWNER, SESSION, collectErrors, signIn, stopLeftoverJobs } from './helpers'

// Accounts: signing in, the team, and what a removed member loses.

const ACTIONS_MENU = /^Actions for/

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

test('a removed member loses their WebSocket', async ({ browser }) => {
    const base = 'http://127.0.0.1:5611'
    const owner = await browser.newContext({ baseURL: base })
    await signIn(owner.request, base)
    const added = (await (
        await owner.request.post('/api/rpc/team_add', {
            headers: SESSION,
            data: { email: 'socket@example.com', password: 'socket-secret1', role: 'member' },
        })
    ).json()) as { ok: boolean; value?: { id: string } }
    expect(added.ok).toBe(true)
    const member = await browser.newContext({ baseURL: base })
    try {
        await signIn(member.request, base, {
            email: 'socket@example.com',
            password: 'socket-secret1',
        })
        const memberPage = await member.newPage()
        await memberPage.goto('/')
        await expect(memberPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
        // A socket of the member's own, beside the page's.
        await memberPage.evaluate(
            () =>
                new Promise<void>((resolve, reject) => {
                    const socket = new WebSocket(`ws://${location.host}/api/ws`)
                    ;(window as unknown as { __e2eSocket?: WebSocket }).__e2eSocket = socket
                    socket.onopen = () => resolve()
                    socket.onerror = () => reject(new Error('the socket did not open'))
                })
        )
        const closed = memberPage.evaluate(
            () =>
                new Promise<boolean>((resolve) => {
                    const socket = (window as unknown as { __e2eSocket?: WebSocket }).__e2eSocket
                    if (!socket || socket.readyState === WebSocket.CLOSED) return resolve(true)
                    socket.onclose = () => resolve(true)
                    setTimeout(() => resolve(false), 10_000)
                })
        )
        // Removal revokes the member's HTTP sessions; their open socket must go with them.
        const removed = (await (
            await owner.request.post('/api/rpc/team_remove', {
                headers: SESSION,
                data: { id: added.value?.id },
            })
        ).json()) as { ok: boolean }
        expect(removed.ok).toBe(true)
        expect(await closed).toBe(true)
    } finally {
        await member.close()
        await owner.close()
    }
})

test('signing in takes the owner account seeded from --password', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5611' })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await page.getByLabel('Email', { exact: true }).fill(OWNER.email)
    await page.getByLabel('Password', { exact: true }).fill('wrong')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Wrong email or password')).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    // The session names the account, and so does the header.
    const session = (await (await page.request.get('/api/session')).json()) as {
        user: { email: string; role: string } | null
    }
    expect(session.user).toMatchObject({ email: OWNER.email, role: 'owner' })
    const header = page.locator('header', {
        has: page.getByRole('button', { name: 'Toggle sidebar' }),
    })
    // Who is signed in is a Settings › Team matter; the header does not repeat it.
    await expect(header.getByText(OWNER.email)).toHaveCount(0)
    await context.close()
})

test('the team: an admin adds a member, the member signs in, removal ends their session', async ({
    browser,
}) => {
    const base = 'http://127.0.0.1:5611'
    const owner = await browser.newContext({ baseURL: base })
    await signIn(owner.request, base)
    // The query cache is persisted to local storage. A session answer restored from it (here:
    // one without a user) must never stand in for the server's.
    await owner.addInitScript(() => {
        const state = {
            data: { ok: true, authenticated: true },
            dataUpdateCount: 1,
            dataUpdatedAt: Date.now(),
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: 'success',
            fetchStatus: 'idle',
        }
        localStorage.setItem(
            'rclone-cloud-persisted-query-cache',
            JSON.stringify({
                timestamp: Date.now(),
                buster: '',
                clientState: {
                    mutations: [],
                    queries: [{ queryHash: '["session"]', queryKey: ['session'], state }],
                },
            })
        )
    })
    const page = await owner.newPage()
    const errors = collectErrors(page)
    await page.goto('/settings/team')
    const members = page.getByRole('list', { name: 'Members' })
    const row = (email: string) => members.getByRole('listitem').filter({ hasText: email })
    await expect(row(OWNER.email).getByText('Owner')).toBeVisible()
    await expect(row(OWNER.email).getByText('You')).toBeVisible()
    // Your own row offers your own settings, never the admin menu.
    await expect(row(OWNER.email).getByRole('button', { name: 'Change password' })).toBeVisible()
    await expect(row(OWNER.email).getByRole('button', { name: ACTIONS_MENU })).toHaveCount(0)

    await page.getByRole('button', { name: 'Add member' }).click()
    await page.getByLabel('Email', { exact: true }).fill('pat@example.com')
    await page.getByLabel('Password', { exact: true }).fill('pat-secret1')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(row('pat@example.com').getByText('Member')).toBeVisible()
    // The Dashboard's getting-started step for the team ticks itself off.
    await page.goto('/')
    const teamStep = page
        .getByRole('region', { name: 'Getting started' })
        .getByRole('list', { name: 'Steps' })
        .getByRole('listitem')
        .filter({ hasText: 'Add a team member' })
    await expect(teamStep.getByText('Done')).toBeVisible()
    await page.goto('/settings/team')

    // The member can use the app, but not run the team.
    const member = await browser.newContext({ baseURL: base })
    await signIn(member.request, base, { email: 'pat@example.com', password: 'pat-secret1' })
    const memberPage = await member.newPage()
    await memberPage.goto('/settings/team')
    await expect(memberPage.getByRole('heading', { name: 'Team' })).toBeVisible()
    await expect(memberPage.getByRole('button', { name: 'Add member' })).toHaveCount(0)
    await expect(memberPage.getByRole('button', { name: ACTIONS_MENU })).toHaveCount(0)
    const denied = (await (
        await member.request.post('/api/rpc/team_remove', { headers: SESSION, data: { id: 'x' } })
    ).json()) as { ok: boolean; error?: string }
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('Only admins')

    // Nobody removes the owner, the owner included.
    const me = (await (await owner.request.get('/api/session')).json()) as {
        user: { id: string }
    }
    const refused = (await (
        await owner.request.post('/api/rpc/team_remove', {
            headers: SESSION,
            data: { id: me.user.id },
        })
    ).json()) as { ok: boolean; error?: string }
    expect(refused.ok).toBe(false)

    // Removing the member ends their session at once.
    await row('pat@example.com')
        .getByRole('button', { name: 'Actions for pat@example.com' })
        .click()
    await page.getByRole('menuitem', { name: 'Remove' }).click()
    await page.getByRole('button', { name: 'Yes' }).click()
    await expect(row('pat@example.com')).toHaveCount(0)
    expect(
        (
            await member.request.post('/api/rpc/scheduler_list', {
                headers: SESSION,
                data: {},
            })
        ).status()
    ).toBe(401)
    expect(errors, errors.join('\n')).toEqual([])
    await member.close()
    await owner.close()
})
