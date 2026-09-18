import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Page, expect, request as playwrightRequest, test } from '@playwright/test'
import { OWNER, SERVER_BIN, signIn, smtpReceiver, stopLeftoverJobs } from './helpers'
import type { TransferDetail } from '../lib/api/transfers'
import { retryPlan, retryRequest } from '../lib/transfers/retry'

// The page's platform layer is plain HTTP + WebSocket (lib/api); these tests exercise the wire
// contract directly through `fetch` and the pages that sit on it.

declare global {
    interface Window {
        __RCLONE_UI__?: { mode: string; capabilities: { mode: string; window: boolean } }
        __RCLONE_UI_API__: typeof import('../lib/api')
    }
}

function collectErrors(page: Page) {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
        const text = m.text()
        if (m.type() === 'error' || /__TAURI|no such command|unknown command/.test(text)) {
            errors.push(`console.${m.type()}: ${text}`)
        }
    })
    return errors
}

const SESSION = { 'X-RcloneUI-Session': 'e2e', 'Content-Type': 'application/json' }
const ACTIONS_MENU = /^Actions for/
const ALL_REMOTES = /^All remotes/
const SIDEBAR_REMOTE = /^sb-/

// What a test's page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

test('dashboard renders inside the shell with the injected boot payload', async ({ page }) => {
    const errors = collectErrors(page)
    // pages.spec.ts ran first against this server and opened the Commander, which ticks a
    // getting-started step; begin from a fresh install's onboarding state.
    const doc = await page.request.get('/api/state/app')
    if (doc.ok()) {
        const { version, state } = (await doc.json()) as {
            version: number
            state: Record<string, unknown>
        }
        await page.request.put('/api/state/app', {
            data: { version, state: { ...state, onboarding: { dismissed: false, completed: [] } } },
        })
    }
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Commander', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__RCLONE_UI__?.mode)).toBe('server')
    expect(await page.evaluate(() => window.__RCLONE_UI__?.capabilities.window)).toBe(false)
    // rclone rcd is up, so the throughput panel resolves through the rc proxy.
    await expect(page.getByText('Idle')).toBeVisible({ timeout: 15_000 })
    // A fresh install shows the getting-started timeline in place of the inventory rows. The
    // remote step ticks itself off (the daemon already has e2e-memory); the Commander one waits.
    const onboarding = page.getByRole('region', { name: 'Getting started' })
    await expect(onboarding).toBeVisible()
    const steps = onboarding.getByRole('list', { name: 'Steps' })
    const step = (title: string) => steps.getByRole('listitem').filter({ hasText: title })
    await expect(steps.getByRole('listitem')).toHaveCount(4)
    await expect(step('Add a remote').getByText('Done')).toBeVisible()
    // Only the owner exists on this server, so the team step waits.
    await expect(step('Add a team member').getByText('Done')).toHaveCount(0)
    // The optional list below points at the rest of the app; every row opens something.
    const optional = onboarding.getByRole('list', { name: 'Optional' })
    await expect(optional.getByRole('listitem')).toHaveCount(3)
    await expect(optional.getByRole('link', { name: 'Schedules' })).toBeVisible()
    await expect(optional.getByRole('link', { name: 'Notifications' })).toBeVisible()
    await expect(optional.getByRole('link', { name: 'Templates' })).toBeVisible()
    await expect(optional.getByText('Coming soon')).toHaveCount(0)
    await expect(step('Browse it in the Commander').getByText('Done')).toHaveCount(0)
    await expect(page.locator('.browser-outlet').getByText('e2e-memory')).toHaveCount(0)
    // Opening the Commander completes its step.
    await step('Browse it in the Commander').getByRole('link', { name: 'Open Commander' }).click()
    await expect(page).toHaveURL(/\/commander$/)
    await page
        .getByRole('navigation', { name: 'Sidebar' })
        .getByRole('link', { name: 'Dashboard' })
        .click()
    await expect(step('Browse it in the Commander').getByText('Done')).toBeVisible()
    // Dismissing it brings the inventory back, and that sticks across a reload.
    const saved = page.waitForResponse(
        (response) =>
            response.url().includes('/api/state/app') && response.request().method() === 'PATCH'
    )
    await onboarding.getByRole('button', { name: 'Dismiss' }).click()
    await saved
    await expect(onboarding).toHaveCount(0)
    await expect(page.locator('.browser-outlet').getByText('e2e-memory')).toBeVisible()
    // Under the operations, the undecided are sent to the Wizard.
    await expect(page.getByRole('button', { name: 'Not sure? Open Wizard' })).toHaveAttribute(
        'href',
        '/wizard'
    )
    await page.reload()
    await expect(page.locator('.browser-outlet').getByText('e2e-memory')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0)
    expect(errors, errors.join('\n')).toEqual([])
})

test('the tab icon follows the browser colour scheme, with a PNG fallback', async ({ page }) => {
    await page.goto('/')
    // Both are declared; a browser takes the last icon whose type it can render, so the SVG
    // wins wherever SVG favicons are supported and the PNG catches everywhere else.
    const icons = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map((l) => l.href)
    )
    expect(icons.map((href) => new URL(href).pathname)).toEqual(['/favicon.png', '/favicon.svg'])
    // A file the bundle never shipped comes back as the SPA fallback (200 text/html), so the
    // content type is what proves these two are really on disk.
    for (const [href, type] of [
        [icons[0], 'image/png'],
        [icons[1], 'image/svg+xml'],
    ]) {
        const response = await page.request.get(href)
        expect(response.status(), href).toBe(200)
        expect(response.headers()['content-type'], href).toContain(type)
    }
    // White is crisp on a dark tab strip and nearly invisible on a light one; the mark carries
    // its own media query so the icon follows the browser instead of picking a side.
    const fill = async (colorScheme: 'dark' | 'light') => {
        await page.emulateMedia({ colorScheme })
        await page.goto(icons[1])
        return await page.evaluate(() => getComputedStyle(document.querySelector('path')!).fill)
    }
    expect(await fill('dark')).toBe('rgb(255, 255, 255)')
    expect(await fill('light')).toBe('rgb(63, 121, 173)')
})

test('the shell: zones, settings routes, the remotes zone and the icon rail', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Sidebar' })
    const header = page.locator('header', {
        has: page.getByRole('button', { name: 'Toggle sidebar' }),
    })
    // The shell renders once both state documents are in; the checks below read the DOM directly.
    await expect(nav).toBeVisible()
    // Overview runs Dashboard, Wizard, Commander, Transfers, Schedules, Templates: the Wizard
    // (plain questions that lead to an operation) comes second, right after the Dashboard.
    expect((await nav.getByRole('link').allInnerTexts()).slice(0, 6)).toEqual([
        'Dashboard',
        'Wizard',
        'Commander',
        'Transfers',
        'Schedules',
        'Templates',
    ])
    // A tab is a web page: page text can be selected, the shell's chrome cannot.
    const selectable = (selector: string) =>
        page.evaluate(
            (target) => getComputedStyle(document.querySelector(target)!).userSelect,
            selector
        )
    expect(await selectable('body')).toBe('text')
    expect(await selectable('nav[aria-label="Sidebar"]')).toBe('none')
    expect(await selectable('header')).toBe('none')
    // Rows keep their height on a short screen; the list scrolls instead of squeezing them.
    await page.setViewportSize({ width: 1400, height: 520 })
    const copyBox = await nav.getByRole('link', { name: 'Copy', exact: true }).boundingBox()
    const moveBox = await nav.getByRole('link', { name: 'Move', exact: true }).boundingBox()
    expect(copyBox?.height).toBe(30)
    expect((moveBox?.y ?? 0) - (copyBox?.y ?? 0)).toBe(32)
    await page.setViewportSize({ width: 1280, height: 720 })
    // Operations are a zone of plain links, nothing to open first; the header breadcrumb follows.
    await nav.getByRole('link', { name: 'Copy', exact: true }).click()
    await expect(page).toHaveURL(/\/copy$/)
    await expect(header.getByText('Operations')).toBeVisible()
    await expect(header.getByText('Copy', { exact: true })).toBeVisible()
    // The footer's "Run another command" launcher is the desktop's; the sidebar covers it here.
    await expect(page.getByRole('button', { name: 'Please select a source path' })).toBeVisible()
    await expect(page.locator('svg.lucide-command')).toHaveCount(0)
    // Schedules and Templates are Overview entries, so the breadcrumb is the page alone; the
    // Automation zone and the Watchers page it announced are gone.
    await nav.getByRole('link', { name: 'Schedules', exact: true }).click()
    await expect(page).toHaveURL(/\/schedules$/)
    await expect(header.getByText('Schedules', { exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Templates', exact: true })).toBeVisible()
    await expect(nav.getByText('Automation')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Watchers', exact: true })).toHaveCount(0)
    // The Settings zone lists its sections as routes. Rclone is the browser's own screen for the
    // binary and the proxy; Binary, Proxy and Hosts keep their routes but are not listed here.
    await nav.getByRole('link', { name: 'Rclone', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/rclone$/)
    await expect(page.getByRole('heading', { name: 'Rclone' })).toBeVisible()
    for (const unlisted of ['Binary', 'Proxy', 'Hosts']) {
        await expect(nav.getByRole('link', { name: unlisted, exact: true })).toHaveCount(0)
    }
    // General is not listed but keeps its route, without the desktop-only rows.
    await page.goto('/settings')
    await expect(page.getByText('Options')).toBeVisible()
    const caps = (await (await page.request.get('/api/capabilities')).json()) as {
        autostart: boolean
        updater: boolean
    }
    await expect(page.getByText('Show Startup screen')).toHaveCount(0)
    await expect(page.getByText('Toolbar Shortcut')).toHaveCount(0)
    await expect(page.getByText('Start on boot')).toHaveCount(caps.autostart ? 1 : 0)
    await expect(page.getByText('Check for updates')).toHaveCount(caps.updater ? 1 : 0)
    // The old ?tab= deep links still land on their section.
    await page.goto('/settings?tab=config')
    await expect(page).toHaveURL(/\/settings\/config$/)
    // A remote in the sidebar opens it in the Commander, which collapses the sidebar to icons.
    await nav.getByRole('link', { name: 'e2e-memory' }).click()
    await expect(page).toHaveURL(/\/commander\?path=e2e-memory%3A$/)
    await expect(nav).toHaveAttribute('data-state', 'collapsed')
    // The Commander row is the current page; a remote is only a link and never lights up.
    await expect(nav.getByRole('link', { name: 'Commander' })).toHaveAttribute(
        'aria-current',
        'page'
    )
    await expect(nav.getByRole('link', { name: 'e2e-memory' })).not.toHaveAttribute(
        'aria-current',
        'page'
    )
    await nav.getByRole('link', { name: 'Dashboard' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Dashboard' })).toBeVisible()
    // Leaving the Commander does not reopen it; only a toggle does.
    await nav.getByRole('link', { name: 'Transfers' }).click()
    await expect(page).toHaveURL(/\/transfers$/)
    await expect(nav).toHaveAttribute('data-state', 'collapsed')
    // Plain questions that lead to an operation; the rail is collapsed, so this is by name.
    await nav.getByRole('link', { name: 'Wizard' }).click()
    await expect(page).toHaveURL(/\/wizard$/)
    await expect(header.getByText('Wizard')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible()
    await header.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(nav).toHaveAttribute('data-state', 'expanded')
    // The seam between the sidebar and the page is a rail: a click on it toggles the sidebar too.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(nav).toHaveAttribute('data-state', 'collapsed')
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(nav).toHaveAttribute('data-state', 'expanded')
    expect(errors, errors.join('\n')).toEqual([])
})

test('rpc round trip: the shared table, the server RPCs and errors', async ({ request }) => {
    const arch = await (
        await request.post('/api/rpc/get_arch', { headers: SESSION, data: {} })
    ).json()
    expect(arch).toMatchObject({ ok: true })
    expect(typeof arch.value).toBe('string')

    const info = await (
        await request.post('/api/rpc/app_info', { headers: SESSION, data: {} })
    ).json()
    expect(info.ok).toBe(true)
    expect(info.value.mode).toBe('server')

    const unknown = await (
        await request.post('/api/rpc/nope', { headers: SESSION, data: {} })
    ).json()
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('unknown command')

    const noSession = await request.post('/api/rpc/get_arch', {
        headers: { 'Content-Type': 'application/json' },
        data: {},
    })
    expect(noSession.status()).toBe(400)
})

test('the reconnect prompt is claimed one at a time, and per host', async ({ request }) => {
    const call = async (name: string, host: string, remote: string) =>
        (await (
            await request.post(`/api/rpc/${name}`, { headers: SESSION, data: { host, remote } })
        ).json()) as { ok: boolean; value?: boolean; error?: string }

    // An expired token fails every call that touches the remote, and each page would ask. The
    // first to ask gets the dialog; the windows behind it stay quiet.
    expect((await call('claim_reconnect_dialog', 'local', 'e2e-recon')).value).toBe(true)
    expect((await call('claim_reconnect_dialog', 'local', 'e2e-recon')).value).toBe(false)

    // The same name on another host is a different remote, with its own token to renew.
    expect((await call('claim_reconnect_dialog', 'other', 'e2e-recon')).value).toBe(true)

    // Once that dialog is done with, the next expiry can ask again — a remote reconnected today
    // expires again later, and a prompt that never came back would leave it failing silently.
    expect((await call('release_reconnect_dialog', 'local', 'e2e-recon')).ok).toBe(true)
    expect((await call('claim_reconnect_dialog', 'local', 'e2e-recon')).value).toBe(true)

    await call('release_reconnect_dialog', 'local', 'e2e-recon')
    await call('release_reconnect_dialog', 'other', 'e2e-recon')
})

test('state documents: PUT, PATCH with If-Match, 409 on a stale revision', async ({ request }) => {
    const put = await request.put('/api/state/hosts/e2e-state', {
        headers: SESSION,
        data: { version: 2, state: { a: 1, b: 'x' } },
    })
    expect(put.ok()).toBe(true)
    const doc = (await put.json()) as {
        version: number
        revision: number
        state: Record<string, unknown>
    }
    expect(doc.version).toBe(2)

    const patch = await request.patch('/api/state/hosts/e2e-state', {
        headers: { ...SESSION, 'If-Match': String(doc.revision) },
        data: { set: { b: 'y' } },
    })
    expect(patch.ok()).toBe(true)
    const next = (await patch.json()) as typeof doc
    expect(next.revision).toBe(doc.revision + 1)
    expect(next.state).toEqual({ a: 1, b: 'y' })

    const stale = await request.patch('/api/state/hosts/e2e-state', {
        headers: { ...SESSION, 'If-Match': String(doc.revision) },
        data: { set: { b: 'z' } },
    })
    expect(stale.status()).toBe(409)
    expect(((await stale.json()) as typeof doc).state).toEqual({ a: 1, b: 'y' })

    const get = (await (
        await request.get('/api/state/hosts/e2e-state', { headers: SESSION })
    ).json()) as typeof doc
    expect(get.state.b).toBe('y')
    const fresh = (await (
        await request.get('/api/state/hosts/never-written', { headers: SESSION })
    ).json()) as typeof doc
    expect(fresh.revision).toBe(0)
    expect(fresh.state).toEqual({})
})

test('two writes from one page to the same document never conflict with each other', async ({
    page,
}) => {
    const errors = collectErrors(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    // The adapter behind every store, fed two updates in the same tick, as an effect that sets
    // several keys does. The second must carry the revision the first produced, not race it
    // (a 409 is recovered from, but the browser still logs it as an error).
    const state = await page.evaluate(async (doc) => {
        const storage = window.__RCLONE_UI_API__.state.stateStorage(() => doc)
        const value = (patch: Record<string, unknown>) =>
            JSON.stringify({ version: 2, state: { a: 1, ...patch } })
        // Hydration reads first, as zustand does; a write before that is dropped (next test).
        await storage.getItem('x')
        await storage.setItem('x', value({}))
        await Promise.all([
            storage.setItem('x', value({ b: 2 })),
            storage.setItem('x', value({ b: 2, c: 3 })),
        ])
        // A write fired without waiting: the barrier resolves once it has landed.
        void storage.setItem('x', value({ b: 2, c: 3, d: 4 }))
        await window.__RCLONE_UI_API__.state.whenWritten(doc)
        return storage.getItem('x')
    }, 'hosts/e2e-queue')
    expect(JSON.parse(state as string).state).toEqual({ a: 1, b: 2, c: 3, d: 4 })
    expect(errors, errors.join('\n')).toEqual([])
})

test('a write before the document was read is dropped', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    // A store that sets state before its document has loaded holds only defaults; writing them
    // would patch defaults over what other pages saved. The adapter drops that write (with a
    // console warning, not an error) and hydration brings the document's truth.
    const state = await page.evaluate(async (doc) => {
        const storage = window.__RCLONE_UI_API__.state.stateStorage(() => doc)
        await storage.setItem('x', JSON.stringify({ version: 2, state: { a: 1 } }))
        return storage.getItem('x')
    }, 'hosts/e2e-unread')
    expect(state).toBeNull()
    expect(errors, errors.join('\n')).toEqual([])
})

test('two pages creating the same document keep both their keys', async ({
    page,
    context,
    request,
}) => {
    const errors = collectErrors(page)
    const other = await context.newPage()
    const otherErrors = collectErrors(other)
    await page.goto('/')
    await other.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    await expect(other.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    // Two pages hydrate an unwritten document at the same time and each write their own key.
    // The second creation is refused (its precondition is revision 0); the loser adopts the
    // winner's document and adds what it lacks, so neither key is lost.
    const doc = 'hosts/e2e-create-race'
    type Holder = Window & {
        __e2eStorage?: {
            getItem: (name: string) => Promise<unknown>
            setItem: (name: string, value: string) => Promise<void>
        }
    }
    const hydrate = (target: Page) =>
        target.evaluate(async (doc) => {
            const storage = window.__RCLONE_UI_API__.state.stateStorage(() => doc)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, doc)
    const write = (target: Page, state: Record<string, unknown>) =>
        target.evaluate(async (state) => {
            const storage = (window as unknown as Holder).__e2eStorage
            if (!storage) throw new Error('the page lost its storage')
            await storage.setItem('x', JSON.stringify({ version: 2, state }))
        }, state)
    await hydrate(page)
    await hydrate(other)
    await Promise.all([write(page, { a: 1 }), write(other, { b: 2 })])
    const stored = async (name: string) =>
        (
            (await (await request.get(`/api/state/${name}`, { headers: SESSION })).json()) as {
                state: Record<string, unknown>
            }
        ).state
    expect(await stored(doc)).toEqual({ a: 1, b: 2 })

    // The same, with the order that loses nothing to chance: the second page hydrated the
    // unwritten document, and by the time it writes the first has created it. It finds that out
    // from its own read instead of a refused creation, and the outcome must be the same. (Left
    // to timing this took the refused-creation path when run alone and this one in a full run,
    // where it removed the first page's key: a page's state was compared with the server's
    // document, so a key it had never heard of read as one it had cleared.)
    const later = 'hosts/e2e-create-later'
    const hydrateDoc = (target: Page, name: string) =>
        target.evaluate(async (name) => {
            const storage = window.__RCLONE_UI_API__.state.stateStorage(() => name)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, name)
    await hydrateDoc(page, later)
    await hydrateDoc(other, later)
    await write(page, { a: 1 })
    await write(other, { b: 2 })
    expect(await stored(later)).toEqual({ a: 1, b: 2 })
    // The precondition on a creation, seen raw: the document exists, so revision 0 is stale.
    const stale = await request.put(`/api/state/${doc}`, {
        headers: { ...SESSION, 'If-Match': '0' },
        data: { version: 2, state: { c: 3 } },
    })
    expect(stale.status()).toBe(409)
    // The browser logs the refused creation (a 409) on its own; the page recovered from it.
    // Nothing else may have gone wrong on either page.
    const unexpected = (list: string[]) => list.filter((line) => !line.includes('409'))
    expect(unexpected(errors), errors.join('\n')).toEqual([])
    expect(unexpected(otherErrors), otherErrors.join('\n')).toEqual([])
    await other.close()
})

test('a page writes what it changed, never what it merely holds', async ({
    page,
    context,
    request,
}) => {
    const errors = collectErrors(page)
    const other = await context.newPage()
    await page.goto('/')
    await other.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    await expect(other.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    // Two pages on one document, each holding all of its keys, as every store does. One changes
    // `x`. The other has not heard yet (the announcement is on its way) and changes `y`, then
    // `z`. Its `x` is the old one, but it never touched it, so it must never write it: a page's
    // changes are what differs from its own last state, not from the server's document.
    const doc = 'hosts/e2e-own-changes'
    const created = await request.put(`/api/state/${doc}`, {
        headers: SESSION,
        data: { version: 2, state: { x: 0, y: 0 } },
    })
    expect(created.ok()).toBe(true)
    type Holder = Window & {
        __e2eStorage?: {
            getItem: (name: string) => Promise<unknown>
            setItem: (name: string, value: string) => Promise<void>
        }
    }
    const hydrate = (target: Page) =>
        target.evaluate(async (doc) => {
            const storage = window.__RCLONE_UI_API__.state.stateStorage(() => doc)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, doc)
    const write = (target: Page, state: Record<string, unknown>) =>
        target.evaluate(async (state) => {
            const storage = (window as unknown as Holder).__e2eStorage
            if (!storage) throw new Error('the page lost its storage')
            await storage.setItem('x', JSON.stringify({ version: 2, state }))
        }, state)
    const stored = async () =>
        (
            (await (await request.get(`/api/state/${doc}`, { headers: SESSION })).json()) as {
                state: Record<string, unknown>
            }
        ).state
    await hydrate(page)
    await hydrate(other)
    await write(page, { x: 9, y: 0 })
    // Refused once (the revision moved), re-applied on top: both changes stand.
    await write(other, { x: 0, y: 5 })
    expect(await stored()).toEqual({ x: 9, y: 5 })
    // Its next change. The `x` it still holds is not one.
    await write(other, { x: 0, y: 5, z: 1 })
    expect(await stored()).toEqual({ x: 9, y: 5, z: 1 })
    // Clearing a key is a change: it was in this page's state and is not any more.
    await write(other, { x: 0, y: 5 })
    expect(await stored()).toEqual({ x: 9, y: 5 })
    const unexpected = (list: string[]) => list.filter((line) => !line.includes('409'))
    expect(unexpected(errors), errors.join('\n')).toEqual([])
    await other.close()
})

test('a malformed precondition is refused, not treated as none', async ({ request }) => {
    const response = await request.patch('/api/state/hosts/e2e-state', {
        headers: { ...SESSION, 'If-Match': 'abc' },
        data: { set: { x: 1 }, unset: [] },
    })
    expect(response.status()).toBe(400)
    expect(await response.text()).toContain('If-Match')
})

test('the log tail reads the application log and nothing else', async ({ request }) => {
    const rpc = (data: Record<string, unknown>) =>
        request.post('/api/rpc/fs_read_tail', { headers: SESSION, data })
    const refused = (await (await rpc({ path: '/etc/hosts', lines: 5 })).json()) as {
        ok: boolean
        error?: string
    }
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('application log')
    const logFile = resolve('e2e/.tmp/open/logs/rclone-ui-server.log')
    const allowed = (await (await rpc({ path: logFile, lines: 5 })).json()) as {
        ok: boolean
        value?: string[]
    }
    expect(allowed.ok).toBe(true)
    expect(Array.isArray(allowed.value)).toBe(true)
})

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
        await expect(memberPage.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
        // A socket of the member's own, said hello on, beside the page's.
        await memberPage.evaluate(
            () =>
                new Promise<void>((resolve, reject) => {
                    const socket = new WebSocket(`ws://${location.host}/api/ws`)
                    ;(window as unknown as { __e2eSocket?: WebSocket }).__e2eSocket = socket
                    socket.onopen = () => {
                        socket.send(JSON.stringify({ type: 'hello', session: 'e2e-revoked' }))
                        resolve()
                    }
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

test('a malformed transfer is refused, not started as an empty one', async () => {
    const base = 'http://127.0.0.1:5612'
    const request = await playwrightRequest.newContext({ baseURL: base })
    await signIn(request, base)
    const reply = (await (
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: { transfer: 'nope' },
        })
    ).json()) as { ok: boolean; error?: string }
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain("invalid 'transfer'")
    await request.dispose()
})

test('a state change by another writer rehydrates an open page', async ({ page, request }) => {
    await page.goto('/settings')
    await expect(page.getByText('Options')).toBeVisible()
    await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(true)

    // Another writer (a second page, the lifecycle) patches the app document: the open page gets
    // `state.changed`, reloads the document and re-applies the theme.
    const doc = (await (await request.get('/api/state/app', { headers: SESSION })).json()) as {
        revision: number
        state: { appearance?: { tray: string; app: string } }
    }
    const setTheme = async (revision: number, app: string) => {
        const response = await request.patch('/api/state/app', {
            headers: { ...SESSION, 'If-Match': String(revision) },
            data: { set: { appearance: { ...(doc.state.appearance ?? { tray: 'system' }), app } } },
        })
        expect(response.ok()).toBe(true)
        return ((await response.json()) as { revision: number }).revision
    }
    const next = await setTheme(doc.revision, 'light')
    await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), {
            timeout: 10_000,
        })
        .toBe(false)
    await setTheme(next, 'dark')
    await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), {
            timeout: 10_000,
        })
        .toBe(true)
})

test('a page that has not heard of another writer leaves that writer’s keys alone, then catches up', async ({
    page,
    request,
}) => {
    type Host = { id: string; name: string }
    type AppDoc = { revision: number; state: { hosts?: Host[]; appearance?: { app: string } } }
    const app = async () =>
        (await (await request.get('/api/state/app', { headers: SESSION })).json()) as AppDoc
    // A writer like any other: refused when the revision has moved, it reads again.
    const renameHost = async (name: string) => {
        for (;;) {
            const doc = await app()
            const hosts = (doc.state.hosts ?? []).map((host) =>
                host.id === 'local' ? { ...host, name } : host
            )
            const response = await request.patch('/api/state/app', {
                headers: { ...SESSION, 'If-Match': String(doc.revision) },
                data: { set: { hosts }, unset: [] },
            })
            if (response.status() !== 409) return expect(response.ok()).toBe(true)
        }
    }
    const hostName = async () =>
        (await app()).state.hosts?.find((host) => host.id === 'local')?.name
    // The server's announcements to this page, held back as a slow socket would.
    let holding = false
    const held: (string | Buffer)[] = []
    let toPage: (message: string | Buffer) => void = () => {}
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
        const server = socket.connectToServer()
        socket.onMessage((message) => server.send(message))
        server.onMessage((message) => {
            if (holding) held.push(message)
            else socket.send(message)
        })
        toPage = (message) => socket.send(message)
    })
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    // The header's cog, opened once: while it is open the rest of the page is hidden from roles.
    const panel = page.getByRole('dialog', { name: 'Settings' })
    const pickTheme = async (name: 'Light' | 'Dark') => {
        await panel.getByRole('button', { name: 'App Theme' }).click()
        await page.getByRole('option', { name }).click()
    }
    try {
        await page.goto('/')
        // The Dashboard's heading is the host's name, which the page itself never writes.
        await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()

        // Another writer renames the host. This page does not hear of it.
        holding = true
        await renameHost('Far Machine')

        // It changes a key of its own, twice. The first write is refused (the revision moved)
        // and re-applied on top. By the second the adapter knows the newer document while the
        // store still holds the old `hosts`: measured against the server's document that would
        // read as this page's change, and be written back over the other writer's.
        await page
            .locator('header', { has: page.getByRole('button', { name: 'Toggle sidebar' }) })
            .getByRole('button', { name: 'Settings' })
            .click()
        await pickTheme('Light')
        await expect.poll(async () => (await app()).state.appearance?.app).toBe('light')
        await pickTheme('Dark')
        await expect.poll(async () => (await app()).state.appearance?.app).toBe('dark')
        expect(await hostName()).toBe('Far Machine')
        // (By its element: the open cog hides the rest of the page from roles.)
        const heading = page.locator('h1')
        await expect(heading).toHaveText('Local Machine')

        // The announcements arrive, none of them newer than what the adapter has adopted. The
        // store is what is behind, and it catches up all the same.
        holding = false
        for (const message of held) toPage(message)
        await expect(heading).toHaveText('Far Machine', { timeout: 10_000 })
        await expect.poll(isDark).toBe(true)
        expect(await hostName()).toBe('Far Machine')
    } finally {
        holding = false
        await renameHost('Local Machine')
    }
})

test('in-page dialogs: ask and prompt', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
    const asked = page.evaluate(async () => {
        const { ask } = window.__RCLONE_UI_API__.dialog
        return ask('Proceed?', {
            title: 'E2E',
            kind: 'warning',
            okLabel: 'Go ahead',
            cancelLabel: 'Nah',
        })
    })
    await expect(page.getByText('Proceed?')).toBeVisible()
    await page.getByRole('button', { name: 'Go ahead' }).click()
    expect(await asked).toBe(true)

    const prompted = page.evaluate(async () => {
        const { prompt } = window.__RCLONE_UI_API__.dialog
        return prompt({ title: 'Name it', message: 'Type', default: 'x' })
    })
    const input = page.getByRole('dialog').getByRole('textbox')
    await expect(input).toHaveValue('x')
    await input.fill('hello')
    await page.getByRole('button', { name: 'OK' }).click()
    expect(await prompted).toBe('hello')
})

test('a streaming command delivers its events over the WebSocket', async ({ page }) => {
    const errors = collectErrors(page)
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-'))
    writeFileSync(join(dir, 'note.txt'), 'hi')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()

    // A one-off `rclone version` through the daemon spawner: its close event is the stream.
    const events = await page.evaluate(async () => {
        const { stream } = window.__RCLONE_UI_API__
        const seen: { kind: string; code: number | null }[] = []
        const handle = await stream<number, { kind: string; code: number | null }>(
            'spawn_rclone',
            { path: '/usr/local/bin/rclone', args: ['version'], env: {} },
            (event) => seen.push(event)
        )
        await handle.done
        return seen
    })
    expect(events.at(-1)).toMatchObject({ kind: 'close', code: 0 })

    // The folder picker renders PathSelector, whose FilePanel lists the daemon's disk.
    const picked = page.evaluate(async (path) => {
        const { pickPath } = window.__RCLONE_UI_API__.dialog
        return pickPath({ directory: true, defaultPath: path })
    }, dir)
    await page.getByRole('button', { name: /PICK CURRENT FOLDER/ }).click({ timeout: 20_000 })
    const result = (await picked) as string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(errors, errors.join('\n')).toEqual([])
})

test('the rc proxy reaches the daemon and streams file bytes', async ({ request }) => {
    const version = await request.post('/api/rc/local/core/version', { headers: SESSION, data: {} })
    expect(version.ok()).toBe(true)
    expect(((await version.json()) as { version: string }).version).toMatch(/^v\d/)

    // Upload through the proxy (multipart), then read it back with a Range through --rc-serve.
    const upload = await request.post(
        '/api/rc/local/operations/uploadfile?fs=e2e-memory:&remote=dir',
        {
            headers: { 'X-RcloneUI-Session': 'e2e' },
            multipart: {
                file0: {
                    name: 'hello.txt',
                    mimeType: 'text/plain',
                    buffer: Buffer.from('hello world'),
                },
            },
        }
    )
    expect(upload.ok()).toBe(true)
    const partial = await request.get('/api/rc/local/[e2e-memory:]/dir/hello.txt', {
        headers: { 'X-RcloneUI-Session': 'e2e', Range: 'bytes=0-4' },
    })
    expect(partial.status()).toBe(206)
    expect(await partial.text()).toBe('hello')

    const link = await (
        await request.post('/api/rpc/download_link', {
            headers: SESSION,
            data: { hostId: 'local', fs: 'e2e-memory:', remote: 'dir/hello.txt' },
        })
    ).json()
    expect(link.ok).toBe(true)
    // Signed links need no session: a system browser opened from a desktop window has no cookie.
    const download = await request.get(link.value as string, { headers: {} })
    expect(download.ok()).toBe(true)
    expect(download.headers()['content-disposition']).toContain('attachment')
    expect(await download.text()).toBe('hello world')

    expect(
        (await request.post('/api/rc/nope/core/version', { headers: SESSION, data: {} })).status()
    ).toBe(503)
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
    await expect(page.getByRole('heading', { name: 'Local Machine' })).toBeVisible()
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
    // one without a user, as an older server gave) must never stand in for the server's.
    await owner.addInitScript(() => {
        const state = {
            data: { ok: true, mode: 'password', required: true, authenticated: true },
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
            'rclone-ui-persisted-query-cache',
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
        (await member.request.post('/api/rpc/app_info', { headers: SESSION, data: {} })).status()
    ).toBe(401)
    expect(errors, errors.join('\n')).toEqual([])
    await member.close()
    await owner.close()
})

test('asset-like file names never bypass the API guard', async ({ request }) => {
    // Both external-daemon servers share the rclone daemon: upload through the open one, then
    // ask the password-protected one for the file without a session. The proxy injects the
    // daemon's credentials, so it must refuse whatever the file is called.
    const upload = await request.post(
        '/api/rc/local/operations/uploadfile?fs=e2e-memory:&remote=guard',
        {
            headers: { 'X-RcloneUI-Session': 'e2e' },
            multipart: {
                file0: {
                    name: 'secret.png',
                    mimeType: 'image/png',
                    buffer: Buffer.from('not a picture'),
                },
            },
        }
    )
    expect(upload.ok()).toBe(true)

    const base = 'http://127.0.0.1:5611'
    for (const path of [
        '/api/rc/local/[e2e-memory:]/guard/secret.png',
        '/api/rc/local/[e2e-memory:]/guard/secret.txt',
    ]) {
        const response = await request.get(`${base}${path}`)
        expect(response.status(), path).toBe(401)
    }
    const put = await request.put(`${base}/api/state/hosts/rogue.png`, {
        headers: SESSION,
        data: { version: 2, state: { a: 1 } },
    })
    expect(put.status()).toBe(401)
})

test('the managed daemon comes up, serves the pages and restarts on request', async ({
    browser,
}) => {
    const base = 'http://127.0.0.1:5612'
    const request = await playwrightRequest.newContext({ baseURL: base })
    await signIn(request, base)
    const phase = async () =>
        (
            (await (await request.get(`${base}/api/status`)).json()) as {
                lifecycle: { phase: string } | null
            }
        ).lifecycle?.phase
    await expect
        .poll(phase, { timeout: 30_000, message: 'lifecycle never reached ready' })
        .toBe('ready')
    const status = (await (await request.get(`${base}/api/status`)).json()) as {
        managedDaemon: boolean
        daemon: { url: string }
        lifecycle: { phase: string; port: number; version: string }
    }
    expect(status.managedDaemon).toBe(true)
    expect(status.daemon.url).toBe(`http://127.0.0.1:${status.lifecycle.port}`)
    expect(status.lifecycle.version).toMatch(/^\d+\.\d+/)

    const context = await browser.newContext({ baseURL: base })
    await signIn(context.request, base)
    const page = await context.newPage()
    const errors = collectErrors(page)
    await page.goto('/')
    await expect(page.getByText('Idle')).toBeVisible({ timeout: 15_000 })
    // The sidebar's Remotes zone comes from the managed daemon's own config.
    await expect(
        page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'e2e-memory' })
    ).toBeVisible()
    await expect(page.getByText('Ready')).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()

    // Two restart requests in a row coalesce into one restart; the daemon comes back on a new pid.
    const before = status.lifecycle as { pid?: number }
    await request.post(`${base}/api/rpc/rclone_restart`, { headers: SESSION, data: {} })
    await request.post(`${base}/api/rpc/rclone_restart`, { headers: SESSION, data: {} })
    await expect
        .poll(
            async () => {
                const s = (await (await request.get(`${base}/api/status`)).json()) as {
                    lifecycle: { phase: string; pid?: number } | null
                }
                return s.lifecycle?.phase === 'ready' && s.lifecycle.pid !== before.pid
            },
            { timeout: 30_000, message: 'daemon did not restart' }
        )
        .toBe(true)
})

test('a daemon that keeps dying is restarted with a growing failure count', async () => {
    const base = 'http://127.0.0.1:5612'
    const request = await playwrightRequest.newContext({ baseURL: base })
    await signIn(request, base)
    type Lifecycle = { phase: string; pid?: number; attempts?: number }
    const lifecycle = async () =>
        (
            (await (await request.get(`${base}/api/status`)).json()) as {
                lifecycle: Lifecycle | null
            }
        ).lifecycle
    await expect.poll(async () => (await lifecycle())?.phase, { timeout: 30_000 }).toBe('ready')

    // Two kills inside the 30 s grace window. The restart in between succeeds, but a daemon
    // that dies again that soon was never healthy: the second crash must count as attempt 2.
    for (const expected of [1, 2]) {
        const pid = (await lifecycle())?.pid
        expect(pid).toBeTruthy()
        process.kill(pid!, 'SIGKILL')
        await expect
            .poll(
                async () => {
                    const current = await lifecycle()
                    return current?.phase === 'failed' ? current.attempts : current?.phase
                },
                { timeout: 15_000, message: `crash ${expected} was not reported with that count` }
            )
            .toBe(expected)
        await expect.poll(async () => (await lifecycle())?.phase, { timeout: 30_000 }).toBe('ready')
    }
})

test('the sidebar lists the five newest remotes, then all of them with a count', async ({
    page,
    request,
}) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/local/${path}`, { headers: SESSION, data })
    const created: string[] = []
    const create = async (name: string) => {
        expect((await rc('config/create', { name, type: 'memory', parameters: {} })).ok()).toBe(
            true
        )
        created.push(name)
    }
    const nav = page.getByRole('navigation', { name: 'Sidebar' })
    const remoteRows = () => nav.getByRole('link', { name: SIDEBAR_REMOTE })
    const link = (name: string) => nav.getByRole('link', { name, exact: true })
    // The remote list is cached for a minute, in the persisted query cache too: load from the
    // daemon's answer, and let the sidebar record what it saw before moving on.
    const freshLoad = async () => {
        await page.goto('/')
        await page.evaluate(() => localStorage.removeItem('rclone-ui-persisted-query-cache'))
        const noted = page
            .waitForResponse(
                (response) =>
                    response.url().includes('/api/state/hosts/') &&
                    response.request().method() === 'PATCH',
                { timeout: 5000 }
            )
            .catch(() => undefined)
        await page.reload()
        await expect(nav.getByRole('link', { name: ALL_REMOTES })).toBeVisible()
        await noted
    }
    try {
        // Six at once are first seen together, so they tie and sort by name; the sixth and the
        // older e2e-memory fall off the sidebar.
        for (const n of [1, 2, 3, 4, 5, 6]) await create(`sb-${n}`)
        await freshLoad()
        await expect(remoteRows()).toHaveCount(5)
        for (const n of [1, 2, 3, 4, 5]) await expect(link(`sb-${n}`)).toBeVisible()
        await expect(link('sb-6')).toHaveCount(0)
        await expect(link('e2e-memory')).toHaveCount(0)
        // The row to the full list says how many there are, and opens it.
        const total = ((await (await rc('config/listremotes', {})).json()) as { remotes: string[] })
            .remotes.length
        expect(total).toBeGreaterThan(5)
        await expect(nav.getByRole('link', { name: ALL_REMOTES })).toContainText(String(total))
        await nav.getByRole('link', { name: ALL_REMOTES }).click()
        await expect(page).toHaveURL(/\/remotes$/)
        // A remote added later is first seen later: it leads, and the last of the batch drops.
        await create('sb-newest')
        await freshLoad()
        await expect(remoteRows()).toHaveCount(5)
        await expect(remoteRows().first()).toHaveAccessibleName('sb-newest')
        await expect(link('sb-5')).toHaveCount(0)
    } finally {
        for (const name of created) await rc('config/delete', { name })
    }
})

test('--clear empties the data directory and seeds the owner again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-clear-'))
    const data = join(root, 'data')
    // Leftovers of an earlier life: an accounts file the server could not even parse, a legacy
    // store, a config. Without --clear the accounts file alone would stop the start.
    mkdirSync(join(data, 'state', 'hosts'), { recursive: true })
    writeFileSync(join(data, 'state', 'team.json'), 'not json')
    writeFileSync(join(data, 'store.json'), '{}')
    mkdirSync(join(data, 'configs', 'old'), { recursive: true })
    writeFileSync(join(data, 'configs', 'old', 'rclone.conf'), '[old]\ntype = memory\n')

    const base = 'http://127.0.0.1:5613'
    const server = spawn(
        SERVER_BIN,
        [
            'serve',
            '--clear',
            '--bind',
            '127.0.0.1:5613',
            '--password',
            'fresh-secret',
            '--email',
            'fresh@example.com',
            '--rclone-url',
            'http://localhost:5572',
            '--data-dir',
            data,
        ],
        { stdio: 'ignore' }
    )
    const request = await playwrightRequest.newContext({ baseURL: base })
    try {
        await expect
            .poll(
                async () => {
                    try {
                        return (await request.get('/api/session')).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 30_000, message: 'the cleared server did not come up' }
            )
            .toBe(true)
        expect(existsSync(join(data, 'store.json'))).toBe(false)
        expect(existsSync(join(data, 'configs', 'old'))).toBe(false)
        // The emptied directory was then brought to the current layout.
        expect(JSON.parse(readFileSync(join(data, 'storage.json'), 'utf8'))).toEqual({ version: 4 })
        // The owner is the one seeded from this start's flags.
        await signIn(request, base, { email: 'fresh@example.com', password: 'fresh-secret' })
        const session = (await (await request.get('/api/session')).json()) as {
            user?: { email: string; role: string }
        }
        expect(session.user).toMatchObject({ email: 'fresh@example.com', role: 'owner' })
    } finally {
        await request.dispose()
        server.kill('SIGTERM')
        await new Promise<void>((resolve) => server.once('exit', () => resolve()))
        rmSync(root, { recursive: true, force: true })
    }
})

test('a data directory laid out by the old app is migrated at startup, once', async () => {
    const data = mkdtempSync(join(tmpdir(), 'rcui-e2e-migrate-'))
    // What the released desktop app left behind: zustand stores as JSON strings inside
    // tauri-plugin-store files, and the downloaded rclone in its single slot.
    const app = JSON.stringify({ state: { rclonePath: '/usr/bin/rclone', hosts: [] }, version: 3 })
    writeFileSync(join(data, 'store.json'), JSON.stringify({ store: app }))
    const host = JSON.stringify({
        state: { favoritePaths: ['e2e-memory:kept'], activeConfigId: 'default' },
        version: 2,
    })
    mkdirSync(join(data, 'hosts', 'local'), { recursive: true })
    writeFileSync(
        join(data, 'hosts', 'local', 'store.json'),
        JSON.stringify({ 'host-store': host })
    )
    // A slot "binary" no probe accepts: it must be left alone and reported, not lost.
    writeFileSync(join(data, 'rclone'), 'not a binary')

    const base = 'http://127.0.0.1:5613'
    const start = () =>
        spawn(
            SERVER_BIN,
            [
                'serve',
                '--bind',
                '127.0.0.1:5613',
                '--password',
                'migrate-secret',
                '--rclone-url',
                'http://localhost:5572',
                '--data-dir',
                data,
            ],
            { stdio: 'ignore' }
        )
    const stop = async (server: ReturnType<typeof spawn>) => {
        server.kill('SIGTERM')
        await new Promise<void>((resolve) => server.once('exit', () => resolve()))
    }
    const up = async (request: Awaited<ReturnType<typeof playwrightRequest.newContext>>) =>
        expect
            .poll(
                async () => {
                    try {
                        return (await request.get('/api/session')).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 30_000, message: 'the migrated server did not come up' }
            )
            .toBe(true)

    let server = start()
    const request = await playwrightRequest.newContext({ baseURL: base })
    try {
        await up(request)
        expect(JSON.parse(readFileSync(join(data, 'storage.json'), 'utf8'))).toEqual({ version: 4 })
        expect(existsSync(join(data, 'store.json'))).toBe(false)
        expect(existsSync(join(data, 'hosts'))).toBe(false)
        expect(existsSync(join(data, 'rclone'))).toBe(true)
        const appDoc = JSON.parse(readFileSync(join(data, 'state', 'app.json'), 'utf8'))
        expect(appDoc).toMatchObject({
            version: 3,
            revision: 1,
            state: { rclonePath: '/usr/bin/rclone' },
        })
        await signIn(request, base, { email: 'admin@localhost', password: 'migrate-secret' })
        const hostDoc = (await (await request.get('/api/state/hosts/local')).json()) as {
            version: number
            state: { favoritePaths?: string[] }
        }
        expect(hostDoc.version).toBe(2)
        expect(hostDoc.state.favoritePaths).toEqual(['e2e-memory:kept'])

        // A second start finds the current layout and changes nothing: the document the first
        // run wrote (with the revision the sign-in and reads left it at) is what it reads.
        await stop(server)
        const before = readFileSync(join(data, 'state', 'hosts', 'local.json'), 'utf8')
        server = start()
        await up(request)
        expect(readFileSync(join(data, 'state', 'hosts', 'local.json'), 'utf8')).toBe(before)
    } finally {
        await request.dispose()
        await stop(server)
        rmSync(data, { recursive: true, force: true })
    }
})

test('on the managed daemon a rename edits the config file in place', async ({ browser }) => {
    const base = 'http://127.0.0.1:5612'
    const context = await browser.newContext({ baseURL: base })
    const request = context.request
    await signIn(request, base)
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`${base}/api/rc/local/${path}`, { headers: SESSION, data })
    await expect
        .poll(
            async () =>
                (
                    (await (await request.get(`${base}/api/status`)).json()) as {
                        lifecycle: { phase: string } | null
                    }
                ).lifecycle?.phase,
            { timeout: 30_000, message: 'lifecycle never reached ready' }
        )
        .toBe('ready')
    // The managed daemon runs on the suite's config file (RCLONE_CONFIG in playwright.config).
    const configFile = new URL('./.tmp/rclone.conf', import.meta.url).pathname
    await rc('config/create', { name: 'sb-file-before', type: 'memory', parameters: {} })
    const before = readFileSync(configFile, 'utf8')
    expect(before).toContain('[sb-file-before]')
    const page = await context.newPage()
    try {
        await page.goto('/remotes')
        const card = page.locator('[data-remote="sb-file-before"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await card.locator('button:has(svg.lucide-settings)').click()
        await page.getByRole('menuitem', { name: 'Edit Config' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('Name', { exact: true }).fill('sb-file-after')
        await dialog.getByRole('button', { name: 'Save Changes' }).click()
        await expect(dialog).toHaveCount(0)
        // Only the section's header line changed; a copy through rc would have moved it.
        await expect
            .poll(() => readFileSync(configFile, 'utf8'))
            .toBe(before.replace('[sb-file-before]', '[sb-file-after]'))
        // rclone re-read the file on its own.
        const remotes = (
            (await (await rc('config/listremotes', {})).json()) as { remotes: string[] }
        ).remotes
        expect(remotes).toContain('sb-file-after')
        expect(remotes).not.toContain('sb-file-before')
        await expect(page.locator('[data-remote="sb-file-after"]')).toBeVisible()
        // The section's own text editor opens on the same file, and a typed section lands in
        // rclone once saved.
        await page.getByRole('button', { name: 'Edit config file' }).click()
        const editor = page.getByRole('dialog').locator('textarea[name="content"]')
        await expect(editor).toHaveValue(/\[sb-file-after\]/)
        const typed = `${await editor.inputValue()}\n[sb-file-typed]\ntype = memory\n`
        await editor.fill(typed)
        await page.getByRole('dialog').getByRole('button', { name: 'Save Changes' }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect
            .poll(
                async () =>
                    ((await (await rc('config/listremotes', {})).json()) as { remotes: string[] })
                        .remotes
            )
            .toContain('sb-file-typed')
        await expect(page.locator('[data-remote="sb-file-typed"]')).toBeVisible()
    } finally {
        await rc('config/delete', { name: 'sb-file-after' })
        await rc('config/delete', { name: 'sb-file-before' })
        await rc('config/delete', { name: 'sb-file-typed' })
        await context.close()
    }
})

test('rclone runs the app itself as its metadata mapper', async ({ request }) => {
    // The whole contract with rclone in one call: `_config.MetadataMapper` only accepts an argv
    // ARRAY (a string is rejected outright, and the macOS binary's path has a space in it), the
    // daemon spawns whatever argv[0] names, and what that program prints is what gets written.
    // `Metadata: true` is not optional — without it rclone never calls the mapper at all.
    const dir = resolve('e2e/.tmp/mapper')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello')

    const response = await request.post('/api/rc/local/operations/copyfile', {
        headers: SESSION,
        data: {
            srcFs: dir,
            srcRemote: 'a.txt',
            dstFs: join(dir, 'out'),
            dstRemote: 'a.txt',
            _config: {
                Metadata: true,
                MetadataMapper: [SERVER_BIN, 'metadata-map', '--set', 'mtime=2001-02-03T04:05:06Z'],
            },
        },
    })
    expect(await response.text()).toBe('{}\n')

    // A constant no source file could have had: it can only come from our own program's stdout.
    expect(statSync(join(dir, 'out', 'a.txt')).mtime.toISOString()).toBe('2001-02-03T04:05:06.000Z')
})

// --- transfers: the record is ours, rclone is the live feed ----------------------------------

type TransferEntry = {
    id: string
    jobid: number
    state: string
    operation: string
    sources: string[]
    destination?: string
    isDryRun: boolean
    stats?: { bytes: number; transfers: number; errors: number }
    error?: string
}

test('a transfer is listed the moment it starts, before rclone has a file in flight', async ({
    request,
}) => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-transfers-now-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'one.txt'), 'one')
    const rpc = async (name: string, data: Record<string, unknown>) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    try {
        const started = await rpc('transfers_start', {
            transfer: {
                hostId: 'local',
                operation: 'copy',
                sources: [join(root, 'src')],
                destination: join(root, 'dst'),
                isDryRun: false,
                request: {
                    endpoint: '/job/batch',
                    body: {
                        inputs: [
                            {
                                _path: 'sync/copy',
                                srcFs: join(root, 'src'),
                                dstFs: join(root, 'dst'),
                            },
                        ],
                    },
                },
            },
        })
        expect(started.error).toBeUndefined()
        expect(typeof started.value.jobid).toBe('number')

        // No polling, no waiting for rclone's `transferring[]`: starting it is what listed it.
        const list = await rpc('transfers_list', { hostId: 'local' })
        const entry = (list.value as TransferEntry[]).find((e) => e.id === started.value.id)
        expect(entry).toMatchObject({
            operation: 'copy',
            sources: [join(root, 'src')],
            destination: join(root, 'dst'),
        })

        // …and it ends in the record with rclone's totals, nobody watching.
        await expect
            .poll(
                async () =>
                    (
                        (await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]
                    ).find((e) => e.id === started.value.id)?.state,
                { timeout: 20_000 }
            )
            .toBe('completed')
        expect(readFileSync(join(root, 'dst', 'one.txt'), 'utf8')).toBe('one')

        // Only the three endpoints the builders emit start a transfer: this is not a second proxy.
        const refused = await rpc('transfers_start', {
            transfer: {
                operation: 'copy',
                request: { endpoint: '/config/dump', body: {} },
            },
        })
        expect(refused.ok).toBe(false)
        expect(refused.error).toContain('does not start a transfer')

        // A launch that dies at once is the START button's error, and is recorded as failed.
        const doomed = await rpc('transfers_start', {
            transfer: {
                operation: 'sync',
                sources: [join(root, 'missing')],
                destination: join(root, 'dst2'),
                request: {
                    endpoint: '/sync/sync',
                    body: { srcFs: join(root, 'missing'), dstFs: join(root, 'dst2') },
                },
            },
        })
        expect(doomed.ok).toBe(false)
        expect(doomed.error).toMatch(/not found|no such file/i)
        const failed = (
            (await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]
        ).find((e) => e.operation === 'sync' && e.sources[0] === join(root, 'missing'))
        expect(failed?.state).toBe('failed')
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('finished transfers survive a server restart, with their totals and their files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-transfers-keep-'))
    const data = join(root, 'data')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.txt'), 'aaaa')
    writeFileSync(join(root, 'src', 'b.txt'), 'bb')
    const base = 'http://127.0.0.1:5614'
    const boot = () =>
        spawn(
            SERVER_BIN,
            [
                'serve',
                '--bind',
                '127.0.0.1:5614',
                '--password',
                'e2e-secret',
                '--rclone-url',
                'http://localhost:5572',
                '--data-dir',
                data,
            ],
            { stdio: 'ignore' }
        )
    const up = async (api: Awaited<ReturnType<typeof playwrightRequest.newContext>>) => {
        await expect
            .poll(
                async () => {
                    try {
                        return (await api.get('/api/session')).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 30_000, message: 'the server did not come up' }
            )
            .toBe(true)
        await signIn(api, base)
    }
    const stop = async (server: ReturnType<typeof boot>) => {
        server.kill('SIGTERM')
        await new Promise<void>((resolve) => server.once('exit', () => resolve()))
    }

    let server = boot()
    let api = await playwrightRequest.newContext({ baseURL: base })
    const rpc = async (name: string, body: Record<string, unknown>) =>
        (await (await api.post(`/api/rpc/${name}`, { headers: SESSION, data: body })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    try {
        await up(api)
        const started = await rpc('transfers_start', {
            transfer: {
                operation: 'copy',
                sources: [join(root, 'src')],
                destination: join(root, 'dst'),
                preset: { operation: 'copy', args: { sources: [join(root, 'src')] } },
                request: {
                    endpoint: '/job/batch',
                    body: {
                        inputs: [
                            {
                                _path: 'sync/copy',
                                srcFs: join(root, 'src'),
                                dstFs: join(root, 'dst'),
                            },
                        ],
                    },
                },
            },
        })
        expect(started.error).toBeUndefined()
        const id = started.value.id as string
        const entry = async () =>
            ((await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]).find(
                (e) => e.id === id
            )
        await expect.poll(async () => (await entry())?.state, { timeout: 20_000 }).toBe('completed')

        await stop(server)
        await api.dispose()
        // The same directory, a new process: rclone's own memory of the job plays no part.
        server = boot()
        api = await playwrightRequest.newContext({ baseURL: base })
        await up(api)

        const kept = await entry()
        expect(kept).toMatchObject({ state: 'completed', operation: 'copy' })
        expect(kept?.stats).toMatchObject({ bytes: 6, transfers: 2, errors: 0 })
        expect((kept as any).preset.operation).toBe('copy')
        const detail = (await rpc('transfers_detail', { id })).value as {
            transferred: { name: string }[]
        }
        expect(detail.transferred.map((file) => file.name).sort()).toEqual(['a.txt', 'b.txt'])
        // On disk it is what it says: one JSONL per host, two lines per transfer.
        const lines = readFileSync(join(data, 'transfers', 'hosts', 'local.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; id: string })
        expect(lines.filter((line) => line.id === id).map((line) => line.event)).toEqual([
            'started',
            'finished',
        ])
    } finally {
        await api.dispose()
        await stop(server)
        rmSync(root, { recursive: true, force: true })
    }
})

test('a transfer whose daemon was replaced ends as interrupted, never as the new daemon’s job', async () => {
    // Job ids start over with every daemon. When the one that took a transfer is replaced (a
    // container restarted, a crash behind a supervisor) the new one soon has a `job 1` of its
    // own, and asking it about ours answers about that. Which daemon is answering is rclone's
    // `executeId`, in the start reply and in every status: a pid would not do, it repeats.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-replaced-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'blob.bin'), Buffer.alloc(4 * 1024 * 1024))
    writeFileSync(join(root, 'rclone.conf'), '[mem]\ntype = memory\n')
    const daemonUrl = 'http://localhost:5581'
    const base = 'http://127.0.0.1:5615'
    const daemon = () =>
        spawn(
            'rclone',
            [
                'rcd',
                '--rc-no-auth',
                '--rc-addr',
                'localhost:5581',
                '--config',
                join(root, 'rclone.conf'),
            ],
            { stdio: 'ignore' }
        )
    const rc = await playwrightRequest.newContext()
    const daemonUp = () =>
        expect
            .poll(
                async () => {
                    try {
                        return (await rc.post(`${daemonUrl}/rc/noop`, { data: {} })).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 20_000, message: 'the daemon did not come up' }
            )
            .toBe(true)
    const gone = (child: ReturnType<typeof daemon>) =>
        new Promise<void>((resolve) => {
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
        })

    const first = daemon()
    let second: ReturnType<typeof daemon> | undefined
    await daemonUp()
    const server = spawn(
        SERVER_BIN,
        [
            'serve',
            '--bind',
            '127.0.0.1:5615',
            '--password',
            'e2e-secret',
            '--rclone-url',
            daemonUrl,
            '--data-dir',
            join(root, 'data'),
        ],
        { stdio: 'ignore' }
    )
    const api = await playwrightRequest.newContext({ baseURL: base })
    const rpc = async (name: string, body: Record<string, unknown>) =>
        (await (await api.post(`/api/rpc/${name}`, { headers: SESSION, data: body })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    try {
        await expect
            .poll(
                async () => {
                    try {
                        return (await api.get('/api/session')).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 30_000, message: 'the server did not come up' }
            )
            .toBe(true)
        await signIn(api, base)

        // Slow enough to be running when its daemon goes.
        await rc.post(`${daemonUrl}/core/bwlimit`, { data: { rate: '64k' } })
        const started = await rpc('transfers_start', {
            transfer: {
                operation: 'copy',
                sources: [join(root, 'src')],
                destination: 'mem:replaced',
                request: {
                    endpoint: '/job/batch',
                    body: {
                        inputs: [
                            { _path: 'sync/copy', srcFs: join(root, 'src'), dstFs: 'mem:replaced' },
                        ],
                    },
                },
            },
        })
        expect(started.error).toBeUndefined()
        const { id, jobid } = started.value as { id: string; jobid: number }
        const entry = async () =>
            ((await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]).find(
                (e) => e.id === id
            )
        expect((await entry())?.state).toBe('running')

        // Another daemon on the same address, with a finished job under the same id.
        await gone(first)
        second = daemon()
        await daemonUp()
        for (let made = 0; made < jobid; made++) {
            await rc.post(`${daemonUrl}/rc/noop`, { data: { _async: true } })
        }
        await expect
            .poll(async () => {
                const status = (await (
                    await rc.post(`${daemonUrl}/job/status`, { data: { jobid } })
                ).json()) as { finished?: boolean }
                return status.finished
            })
            .toBe(true)

        await expect
            .poll(async () => (await entry())?.state, { timeout: 30_000 })
            .toBe('interrupted')
    } finally {
        await api.dispose()
        await rc.dispose()
        server.kill('SIGTERM')
        first.kill('SIGKILL')
        second?.kill('SIGKILL')
        rmSync(root, { recursive: true, force: true })
    }
})

test('saving a config file is not moving files, as far as getting started goes', async ({
    browser,
}) => {
    // "Move some files" ticked itself off when the record had a transfer or rclone's own
    // counter was above zero, and rclone counts every file written through it: on a server
    // that has never transferred anything, saving rclone.conf marked the step done.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-onboard-'))
    const base = 'http://127.0.0.1:5616'
    const server = spawn(
        SERVER_BIN,
        [
            'serve',
            '--bind',
            '127.0.0.1:5616',
            '--password',
            'e2e-secret',
            '--rclone-url',
            'http://localhost:5572',
            '--data-dir',
            join(root, 'data'),
        ],
        { stdio: 'ignore' }
    )
    const context = await browser.newContext({ baseURL: base })
    try {
        await expect
            .poll(
                async () => {
                    try {
                        return (await context.request.get('/api/session')).ok()
                    } catch {
                        return false
                    }
                },
                { timeout: 30_000, message: 'the server did not come up' }
            )
            .toBe(true)
        await signIn(context.request, base)
        // What saving a config file does: a write through the daemon.
        const written = await context.request.post(
            `/api/rc/local/operations/uploadfile?fs=${encodeURIComponent(root)}&remote=`,
            {
                headers: { 'X-RcloneUI-Session': 'e2e' },
                multipart: {
                    file0: {
                        name: 'rclone.conf',
                        mimeType: 'text/plain',
                        buffer: Buffer.from('[x]'),
                    },
                },
            }
        )
        expect(written.ok()).toBe(true)

        const page = await context.newPage()
        await page.goto('/')
        const steps = page
            .getByRole('region', { name: 'Getting started' })
            .getByRole('list', { name: 'Steps' })
        const step = (title: string) => steps.getByRole('listitem').filter({ hasText: title })
        // The daemon has a remote, so that step is done: the page has read what it goes by.
        await expect(step('Add a remote').getByText('Done')).toBeVisible({ timeout: 15_000 })
        await page.waitForTimeout(2500)
        await expect(step('Move some files').getByText('Done')).toHaveCount(0)
    } finally {
        await context.close()
        server.kill('SIGTERM')
        rmSync(root, { recursive: true, force: true })
    }
})

test('a download from a URL is a transfer like any other', async ({ request }) => {
    // The Download page ran `operations/copyurl` on rclone directly, wrapped in three retries:
    // nothing recorded it, and a start whose reply got lost ran twice. It goes through the
    // recorded start now, as a batch of one input, which is where every other transfer goes.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-copyurl-'))
    const served = createServer((incoming, reply) => {
        if (incoming.url === '/files/notes.txt') {
            reply.writeHead(200, { 'Content-Type': 'text/plain' })
            reply.end('from the web')
        } else {
            reply.writeHead(404)
            reply.end('no')
        }
    })
    await new Promise<void>((resolve) => served.listen(0, '127.0.0.1', () => resolve()))
    const port = (served.address() as { port: number }).port
    const rpc = async (name: string, data: Record<string, unknown>) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    const download = (url: string, remote: string) =>
        rpc('transfers_start', {
            transfer: {
                hostId: 'local',
                operation: 'download',
                sources: [url],
                destination: join(root, remote),
                request: {
                    endpoint: '/job/batch',
                    body: {
                        inputs: [
                            {
                                _path: 'operations/copyurl',
                                fs: root,
                                remote,
                                url,
                                autoFilename: false,
                            },
                        ],
                    },
                },
            },
        })
    try {
        const started = await download(`http://127.0.0.1:${port}/files/notes.txt`, 'saved.txt')
        expect(started.error).toBeUndefined()
        const entry = async (id: string) =>
            ((await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]).find(
                (e) => e.id === id
            )
        await expect
            .poll(async () => (await entry(started.value.id))?.state, { timeout: 20_000 })
            .toBe('completed')
        expect(readFileSync(join(root, 'saved.txt'), 'utf8')).toBe('from the web')
        expect(await entry(started.value.id)).toMatchObject({
            operation: 'download',
            sources: [`http://127.0.0.1:${port}/files/notes.txt`],
            tags: [],
        })

        // One that is not there dies at launch: the START button's error, named by its file,
        // and a failed transfer on record.
        const missing = await download(`http://127.0.0.1:${port}/files/gone.txt`, 'gone.txt')
        expect(missing.error).toMatch(/^gone\.txt: .*404/)
    } finally {
        served.close()
        rmSync(root, { recursive: true, force: true })
    }
})

test('a launch that dies says it failed, and never that it started', async ({ request }) => {
    // "Transfer started" used to go out the moment rclone took the job, a second before the
    // launch check: a wrong path announced a start, then a failure, then the START button's
    // error. It is said once the launch has held.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-hooks-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.txt'), 'a')
    const heard: { event: string; about: string }[] = []
    const hook = createServer((incoming, reply) => {
        let body = ''
        incoming.on('data', (chunk) => {
            body += chunk
        })
        incoming.on('end', () => {
            const sent = JSON.parse(body || '{}') as { event?: string; body?: string }
            heard.push({ event: sent.event ?? '', about: sent.body ?? '' })
            reply.end('ok')
        })
    })
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', () => resolve()))
    const port = (hook.address() as { port: number }).port
    const rpc = async (name: string, data: Record<string, unknown>) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    const copy = (from: string, to: string) =>
        rpc('transfers_start', {
            transfer: {
                hostId: 'local',
                operation: 'copy',
                sources: [from],
                destination: to,
                request: {
                    endpoint: '/job/batch',
                    body: { inputs: [{ _path: 'sync/copy', srcFs: from, dstFs: to }] },
                },
            },
        })
    const target = await rpc('notifications_add_target', {
        target: {
            provider: 'webhook',
            name: 'e2e hook',
            url: `http://127.0.0.1:${port}/hook`,
            isEnabled: true,
            events: ['job.started', 'job.completed', 'job.failed'],
        },
    })
    expect(target.error).toBeUndefined()
    try {
        const died = await copy(join(root, 'not-there'), join(root, 'dst-a'))
        expect(died.ok).toBe(false)
        await expect.poll(() => heard.map((hit) => hit.event)).toEqual(['job.failed'])
        // Nothing about it arrives late either.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(heard.map((hit) => hit.event)).toEqual(['job.failed'])

        // One that holds says both, in order. Six of them back to back: each start holds its
        // transfer for the second of its launch check, so between them they cover a whole
        // interval of the ticker, which runs on its own clock. One that landed inside a launch
        // used to end the transfer and say "completed" before "started" had been said.
        for (let round = 0; round < 6; round++) {
            heard.length = 0
            const to = join(root, `dst-${round}`)
            const held = await copy(join(root, 'src'), to)
            expect(held.error).toBeUndefined()
            await expect
                .poll(() => heard.filter((hit) => hit.about.includes(to)).map((hit) => hit.event), {
                    timeout: 15_000,
                })
                .toEqual(['job.started', 'job.completed'])
        }
    } finally {
        await rpc('notifications_remove_target', { id: target.value?.id })
        hook.close()
        rmSync(root, { recursive: true, force: true })
    }
})

test('an email notification goes out through the SMTP settings', async ({ page, request }) => {
    // Email is a provider like the others: a target with a name and its recipients, its events,
    // Send Test, and a delivery record. What differs is the way out: the mail server saved on
    // the SMTP screen, read by the server (and the headless runner) at the moment it sends.
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
        fromAddress: 'rclone-ui@example.com',
        fromName: 'Rclone UI e2e',
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
        expect(sent.from).toBe('rclone-ui@example.com')
        expect(sent.to).toEqual(['ops@example.com', 'alice@example.com'])
        expect(sent.message).toContain('Subject: Test notification')
        expect(sent.message).toMatch(/^From: .*Rclone UI e2e.*<rclone-ui@example.com>/m)
        expect(sent.message).toContain('This is a test notification from Rclone UI for "Ops".')
        // The footer's dash travels quoted-printable, as any mail client reads it back.
        expect(sent.message).toContain('=E2=80=94 Rclone UI v')
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

test('a scheduled run keeps the files that failed early, as the server does', async ({
    browser,
}) => {
    // rclone forgets all but a job's last 100 files. The server gathers a transfer's failures
    // while it runs; a scheduled run read its files once, at the end, so a long run kept only
    // the failures among its last hundred.
    const base = 'http://127.0.0.1:5612'
    const context = await browser.newContext({ baseURL: base })
    const api = context.request
    await signIn(api, base)
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-run-failed-'))
    mkdirSync(join(root, 'src'))
    // First in rclone's order, so it fails at once and 120 files finish after it.
    const locked = join(root, 'src', '000-locked.txt')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0o000)
    for (let n = 1; n <= 120; n++) {
        writeFileSync(
            join(root, 'src', `file-${String(n).padStart(3, '0')}.bin`),
            Buffer.alloc(4096)
        )
    }
    const taskId = `e2e-collect-${Date.now()}`
    // The memory remote: a copy between two local folders is a clone on macOS, which no
    // bandwidth limit slows down.
    const destination = `e2e-memory:run-collect-${Date.now()}`
    const rpc = async (name: string, data: Record<string, unknown>) =>
        (await (await api.post(`${base}/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    try {
        await expect
            .poll(
                async () =>
                    (
                        (await (await api.get(`${base}/api/status`)).json()) as {
                            lifecycle: { phase: string } | null
                        }
                    ).lifecycle?.phase,
                { timeout: 30_000, message: 'lifecycle never reached ready' }
            )
            .toBe('ready')
        const host = (await (
            await api.get(`${base}/api/state/hosts/local`, { headers: SESSION })
        ).json()) as { state: { activeConfigId?: string } }
        const registered = await rpc('scheduler_register', {
            enabled: false,
            spec: {
                schemaVersion: 1,
                taskId,
                hostId: 'local',
                name: 'E2E collect',
                operation: 'copy',
                cron: '0 3 1 1 *',
                configId: host.state.activeConfigId ?? 'default',
                binary: '/usr/local/bin/rclone',
                sources: [`${join(root, 'src')}/`],
                destination: destination,
                requests: [
                    // Slow enough for the run to look at its files while they go by.
                    { endpoint: '/core/bwlimit', body: { rate: '64k', _async: true } },
                    {
                        endpoint: '/job/batch',
                        body: {
                            inputs: [
                                {
                                    _path: 'sync/copy',
                                    srcFs: `${join(root, 'src')}/`,
                                    dstFs: destination,
                                },
                            ],
                            _async: true,
                        },
                    },
                ],
            },
        })
        expect(registered.error).toBeUndefined()
        expect((await rpc('scheduler_run_now', { taskId })).error).toBeUndefined()

        const run = async () =>
            ((await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]).find(
                (entry) => entry.taskId === taskId && entry.destination === destination
            )
        await expect.poll(async () => (await run())?.state, { timeout: 60_000 }).toBe('failed')
        const id = (await run())!.id
        const detail = (await rpc('transfers_detail', { id })).value as TransferDetail
        // By the end rclone's own list no longer holds it…
        expect(detail.transferred?.some((file) => file.name === '000-locked.txt')).toBe(false)
        // …and the run does.
        expect(detail.failed?.map((file) => file.name)).toEqual(['000-locked.txt'])
    } finally {
        chmodSync(locked, 0o644)
        await rpc('scheduler_unregister', { taskId, hostId: 'local' })
        await context.close()
        rmSync(root, { recursive: true, force: true })
    }
})

test('a file that failed inside a folder copy is retried as a transfer of its own', async ({
    request,
}) => {
    // rclone does not retry a failed file within a job, and forgets all but a job's last 100
    // files. The server keeps the request and gathers the failures as they go by, which is what
    // a retry is made from — by the same rules the page uses.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-retry-'))
    mkdirSync(join(root, 'src', 'sub'), { recursive: true })
    writeFileSync(join(root, 'src', 'fine.txt'), 'fine')
    writeFileSync(join(root, 'src', 'sub', 'locked.txt'), 'locked')
    chmodSync(join(root, 'src', 'sub', 'locked.txt'), 0o000)
    const rpc = async (name: string, data: Record<string, unknown>) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: any
            error?: string
        }
    const entryOf = async (id: string) =>
        (
            (await rpc('transfers_list', { hostId: 'local' })).value as (TransferEntry & {
                retryOf: string | null
            })[]
        ).find((entry) => entry.id === id)
    try {
        const started = await rpc('transfers_start', {
            transfer: {
                operation: 'copy',
                sources: [`${join(root, 'src')}/`],
                destination: join(root, 'dst'),
                request: {
                    endpoint: '/job/batch',
                    body: {
                        inputs: [
                            {
                                _path: 'sync/copy',
                                srcFs: `${join(root, 'src')}/`,
                                dstFs: join(root, 'dst'),
                                _filter: '{"MinSize":"1B"}',
                            },
                        ],
                    },
                },
            },
        })
        // The folder's one failed file fails the launch, and the transfer is on record as failed.
        expect(started.ok).toBe(false)
        const failedEntry = (
            (await rpc('transfers_list', { hostId: 'local' })).value as TransferEntry[]
        ).find((entry) => entry.sources[0] === `${join(root, 'src')}/`)
        expect(failedEntry?.state).toBe('failed')
        expect(readFileSync(join(root, 'dst', 'fine.txt'), 'utf8')).toBe('fine')

        const detail = (await rpc('transfers_detail', { id: failedEntry!.id }))
            .value as TransferDetail
        expect(detail.request?.endpoint).toBe('/job/batch')
        expect(detail.failed?.map((file) => file.name)).toEqual(['sub/locked.txt'])

        const items = retryPlan(detail)
        expect(items.map((item) => [item.kind, item.label])).toEqual([['file', 'sub/locked.txt']])

        chmodSync(join(root, 'src', 'sub', 'locked.txt'), 0o644)
        const retried = await rpc('transfers_start', {
            transfer: {
                operation: 'copy',
                sources: items.map((item) => item.source),
                destination: join(root, 'dst'),
                retryOf: failedEntry!.id,
                request: retryRequest(items, detail),
            },
        })
        expect(retried.error).toBeUndefined()
        await expect
            .poll(async () => (await entryOf(retried.value.id))?.state, { timeout: 20_000 })
            .toBe('completed')
        expect(readFileSync(join(root, 'dst', 'sub', 'locked.txt'), 'utf8')).toBe('locked')
        expect((await entryOf(retried.value.id))?.retryOf).toBe(failedEntry!.id)
    } finally {
        chmodSync(join(root, 'src', 'sub', 'locked.txt'), 0o644)
        rmSync(root, { recursive: true, force: true })
    }
})
