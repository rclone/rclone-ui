import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { SESSION, collectErrors, stopLeftoverJobs } from './helpers'

// The shell around every page: the boot payload, the sidebar, the header, the in-page dialogs.

const ALL_REMOTES = /^All remotes/
const SIDEBAR_REMOTE = /^sb-/

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
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
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Commander', exact: true })).toBeVisible()
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
    expect(await selectable('body')).not.toBe('none')
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
    await expect(page.getByRole('button', { name: 'Please select a source path' })).toBeVisible()
    // Schedules and Templates are Overview entries, so the breadcrumb is the page alone.
    await nav.getByRole('link', { name: 'Schedules', exact: true }).click()
    await expect(page).toHaveURL(/\/schedules$/)
    await expect(header.getByText('Schedules', { exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Templates', exact: true })).toBeVisible()
    // The Settings zone lists its sections as routes. Rclone is the screen for the binary and
    // the proxy.
    await nav.getByRole('link', { name: 'Rclone', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/rclone$/)
    await expect(page.getByRole('heading', { name: 'Rclone' })).toBeVisible()
    // The bare /settings lands on Rclone, which carries the server's own update where the
    // machine lets it install one.
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Rclone' })).toBeVisible()
    const caps = await page.evaluate(
        () =>
            (window as unknown as { __RCLONE_CLOUD__: { capabilities: { updater: boolean } } })
                .__RCLONE_CLOUD__.capabilities
    )
    await expect(page.getByText('Check for updates')).toHaveCount(caps.updater ? 1 : 0)
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

test('in-page dialogs: ask and prompt', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const asked = page.evaluate(async () => {
        const { ask } = window.__RCLONE_CLOUD_API__.dialog
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
        const { prompt } = window.__RCLONE_CLOUD_API__.dialog
        return prompt({ title: 'Name it', message: 'Type', default: 'x' })
    })
    const input = page.getByRole('dialog').getByRole('textbox')
    await expect(input).toHaveValue('x')
    await input.fill('hello')
    await page.getByRole('button', { name: 'OK' }).click()
    expect(await prompted).toBe('hello')
})

test('the folder picker lists the daemon’s disk and returns the chosen path', async ({ page }) => {
    const errors = collectErrors(page)
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-'))
    writeFileSync(join(dir, 'note.txt'), 'hi')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // The folder picker renders PathSelector, whose FilePanel lists the daemon's disk.
    const picked = page.evaluate(async (path) => {
        const { pickPath } = window.__RCLONE_CLOUD_API__.dialog
        return pickPath({ directory: true, defaultPath: path })
    }, dir)
    await page.getByRole('button', { name: /PICK CURRENT FOLDER/ }).click({ timeout: 20_000 })
    const result = (await picked) as string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(errors, errors.join('\n')).toEqual([])
})

test('the sidebar lists the five newest remotes, then all of them with a count', async ({
    page,
    request,
}) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
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
        await page.evaluate(() => localStorage.removeItem('rclone-cloud-persisted-query-cache'))
        const noted = page
            .waitForResponse(
                (response) =>
                    response.url().includes('/api/state/app') &&
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
