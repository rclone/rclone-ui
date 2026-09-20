import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type Page, expect, test } from '@playwright/test'
import { encodePreset, presetRoute } from '../src/lib/rclone/preset'
import { stopLeftoverJobs } from './helpers'

// Page flows against the open server (127.0.0.1:5610). Each test drives a real page through a
// user-facing path and checks the effect where it lands: the state document, the rc request, or
// the file system.

const SESSION = { 'X-RcloneCloud-Client': 'web', 'Content-Type': 'application/json' }

// What a test's page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

test("copy and move open on their preset's destination", async ({ page }) => {
    const args = { sources: ['/tmp/e2e-src'], destination: '/tmp/e2e-dst' }
    for (const route of [
        presetRoute({ operation: 'copy', args }),
        presetRoute({ operation: 'move', args }),
    ]) {
        await page.goto(route)
        await expect(page.getByLabel('Destination')).toHaveValue('/tmp/e2e-dst')
    }
})

test('the Remotes option section only appears when a path names a remote', async ({ page }) => {
    // Its tabs are one remote's own backend flags each, so a copy between two local paths has
    // nothing to put in it.
    await page.goto(
        presetRoute({
            operation: 'copy',
            args: { sources: ['/tmp/e2e-src'], destination: '/tmp/e2e-dst' },
        })
    )
    const remotes = page.locator('button:has(svg.lucide-server)')
    // The accordion is up (its metadata section is always there) and Remotes is not part of it.
    await expect(page.locator('button:has(svg.lucide-tags)')).toBeVisible()
    await expect(remotes).toHaveCount(0)

    // One remote end is enough for the section, and it opens on that remote's tab.
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:backup')
    await expect(remotes).toBeVisible()
    const nudge = page.getByText('Show more options')
    if (await nudge.isVisible()) await nudge.dispatchEvent('click')
    await remotes.click()
    await expect(page.getByRole('tab', { name: 'E2E-MEMORY' })).toBeVisible()
})

test('Config offers what rclone applies to a transfer, and nothing it would not', async ({
    page,
}) => {
    await page.goto('/copy')
    const nudge = page.getByText('Show more options')
    if (await nudge.isVisible()) await nudge.dispatchEvent('click')
    await page.locator('button:has(svg.lucide-wrench)').click()
    const option = (name: string) => page.getByText(name, { exact: true })
    for (const name of ['transfers', 'checkers', 'bwlimit_file']) {
        await expect(option(name)).toBeVisible()
    }
    // The process's budgets (Settings › Rclone), and what belongs to a remote's first opening.
    for (const name of ['bwlimit', 'tpslimit', 'tpslimit_burst', 'timeout', 'user_agent']) {
        await expect(option(name)).toHaveCount(0)
    }
})

test('the mount point picker only offers local folders', async ({ page }) => {
    await page.goto('/mount')
    // Source picker first, mount point picker second.
    await page.locator('button:has(svg.lucide-folder-open)').nth(1).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: /PICK CURRENT FOLDER/ })).toBeVisible()
    // The sidebar lists the local disks; remote buttons (a backend icon each) must not appear.
    await expect(dialog.locator('svg.lucide-hard-drive').first()).toBeVisible()
    await page.waitForTimeout(1500)
    await expect(dialog.locator('img[src^="/icons/backends/"]')).toHaveCount(0)
})

test('a machine that cannot mount says why, and the remotes ask again on every visit', async ({
    page,
}) => {
    // The server's answer, stood in for: the machine the suite runs on can mount.
    let supported = false
    await page.route('**/api/rpc/mount_support', (route) =>
        route.fulfill({
            json: {
                ok: true,
                value: supported
                    ? { supported: true }
                    : {
                          supported: false,
                          reason: 'There is no /dev/fuse: a container needs --device /dev/fuse --cap-add SYS_ADMIN.',
                          docs: 'https://rclone.org/install/#docker',
                      },
            },
        })
    )
    const autoMount = page.getByRole('menuitem', { name: 'Auto Mount' })
    const openMenu = async () => {
        await page.goto('/remotes')
        await page.getByRole('button', { name: 'Actions for e2e-memory', exact: true }).click()
        await expect(page.getByRole('menuitem', { name: 'Edit Config' })).toBeVisible()
    }
    await openMenu()
    await expect(autoMount).toHaveCount(0)

    // A mount that fails is explained by what the machine lacks, with the way to the docs.
    await page.goto('/mount')
    await page.evaluate(() => {
        window.open = (url) => {
            ;(window as unknown as { __opened?: string }).__opened = String(url)
            return null
        }
    })
    await page.getByLabel('Remote Path', { exact: true }).fill('e2e-memory:')
    await page.getByLabel('Mount Point', { exact: true }).fill('/nonexistent/e2e-mount-point')
    await page.getByRole('button', { name: 'START MOUNT' }).click()
    const dialog = page.getByRole('dialog', { name: 'This server cannot mount' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText(/There is no \/dev\/fuse/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Open the docs' }).click()
    expect(await page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toBe(
        'https://rclone.org/install/#docker'
    )

    // Set up while the server runs: the next visit offers Auto Mount, with no restart.
    supported = true
    await openMenu()
    await expect(autoMount).toBeVisible()
})

test('the template drawer keeps its input when the name is missing', async ({ page }) => {
    await page.goto('/templates')
    // With no templates there is nothing to search or select: the top bar stays away and the
    // empty state is the way in.
    await expect(page.getByText('No templates yet')).toBeVisible()
    await expect(page.getByPlaceholder('Search Templates')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'TEMPLATE', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'New template' }).click()
    const importInput = page.getByPlaceholder('rclone copy --vfs-cache-mode writes ...')
    const imported = page.getByText(/flags? imported/)

    await importInput.fill('rclone copy --transfers=8 src dst')
    await expect(imported).toHaveText('1 flag imported', { timeout: 15_000 })
    await expect(imported).toBeHidden({ timeout: 10_000 })

    // A command without flags imports nothing (the badge stays away).
    await importInput.fill('rclone copy src dst')
    await page.waitForTimeout(2500)
    await expect(imported).toHaveCount(0)

    await page.getByRole('button', { name: 'Add Template', exact: true }).click()
    await expect(page.getByText('Please enter a name for the template')).toBeVisible()
    await page.getByRole('button', { name: 'Ok' }).click()
    // Still open, nothing lost (a closing drawer would have reset every field).
    await page.waitForTimeout(1000)
    await expect(page.locator('p', { hasText: 'Add Template' })).toBeVisible()
    await expect(importInput).toHaveValue('rclone copy src dst')
    // Named, it saves; the first template brings the search and add bar with it.
    await page.getByPlaceholder('My Template').fill('e2e template')
    await page.getByRole('button', { name: 'Add Template', exact: true }).click()
    await expect(page.locator('p', { hasText: 'Add Template' })).toBeHidden()
    await expect(page.getByPlaceholder('Search Templates')).toBeVisible()
    await expect(page.getByRole('button', { name: 'TEMPLATE', exact: true })).toBeVisible()
})

test('a folder dropped in the commander is copied as a folder, without overwriting', async ({
    page,
    request,
}) => {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-drop-'))
    const upload = await request.post(
        '/api/rc/operations/uploadfile?fs=e2e-memory:&remote=dropdir',
        {
            headers: { 'X-RcloneCloud-Client': 'web' },
            multipart: {
                file0: { name: 'inner.txt', mimeType: 'text/plain', buffer: Buffer.from('inner') },
            },
        }
    )
    expect(upload.ok()).toBe(true)

    // Right panel on the empty temp folder, left panel on the memory remote. Two panels with
    // their sidebars need room, or the name column collapses and rows can't be dragged.
    await page.setViewportSize({ width: 1800, height: 900 })
    // What the page asks rclone about its jobs, counted from the start.
    let asked = 0
    page.on('request', (sent) => {
        if (/\/api\/rc\/local\/(core\/stats|core\/transferred|job\/status)/.test(sent.url())) {
            asked += 1
        }
    })
    await page.goto(`/commander?path=${encodeURIComponent(dir)}`)
    const rightPanel = page.getByText('No items').last()
    await expect(rightPanel).toBeVisible({ timeout: 15_000 })
    await page.locator('img[alt="memory"]').first().click()
    const folder = page.locator('span[title="e2e-memory:dropdir"]')
    await expect(folder).toBeVisible({ timeout: 15_000 })

    await folder.dragTo(rightPanel)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Copy 1 item')).toBeVisible()
    await expect(
        dialog.getByRole('checkbox', { name: 'Overwrite existing files' })
    ).not.toBeChecked()
    // The page hands its batch to the server, which submits and records it in one step.
    const start = page.waitForRequest((sent) => sent.url().includes('/api/rpc/transfers_start'))
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click()

    const body = (await start).postData() ?? ''
    expect(body).toContain('"endpoint":"/job/batch"')
    expect(body).toContain('"tags":["commander"]')
    // A folder goes through sync/copy; "don't overwrite" is --ignore-existing.
    expect(body).toContain('sync/copy')
    expect(body).not.toContain('copyfile')
    expect(body).toMatch(/IgnoreExisting\\?":true/)
    expect(body).not.toContain('NoUpdateModTime')
    await expect
        .poll(() => existsSync(join(dir, 'dropdir', 'inner.txt')), { timeout: 20_000 })
        .toBe(true)

    // The page's bar has the file. Which of the page's transfers still run is the record's to
    // say, and rclone is asked about those only: once this one has ended the bar asks nothing
    // more. (It used to poll every job the page had ever started, for as long as it stayed open.)
    const bar = page.getByRole('region', { name: 'Page activity' })
    await bar.getByRole('button', { name: 'Show activity' }).click()
    await expect(bar.getByText('inner.txt').first()).toBeVisible({ timeout: 10_000 })
    await expect(bar.getByText(/\d+ active/)).toHaveCount(0, { timeout: 15_000 })
    const settled = asked
    await page.waitForTimeout(2500)
    expect(asked).toBe(settled)
})

test('a download from the Commander is a transfer like any other, tagged with where it came from', async ({
    page,
    request,
}) => {
    // It used to start on rclone directly: nothing recorded it, so it was in no list, was not
    // watched once the page closed, and could not be retried.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-download-'))
    const upload = await request.post(
        '/api/rc/operations/uploadfile?fs=e2e-memory:&remote=downloads',
        {
            headers: { 'X-RcloneCloud-Client': 'web' },
            multipart: {
                file0: {
                    name: 'report.txt',
                    mimeType: 'text/plain',
                    buffer: Buffer.from('report'),
                },
            },
        }
    )
    expect(upload.ok()).toBe(true)
    try {
        await page.setViewportSize({ width: 1800, height: 900 })
        await page.goto('/commander')
        await page.locator('img[alt="memory"]').first().click()
        const folder = page.locator('span[title="e2e-memory:downloads"]')
        await expect(folder).toBeVisible({ timeout: 15_000 })
        await folder.dblclick()
        const file = page.locator('[draggable]', { hasText: 'report.txt' }).first()
        await expect(file).toBeVisible({ timeout: 15_000 })

        // The row's download button, then where to save it: a folder, then a name.
        await file.hover()
        const start = page.waitForRequest((sent) => sent.url().includes('/api/rpc/transfers_start'))
        await file.locator('button:has(svg.lucide-download)').click()
        const picker = page.getByRole('dialog').filter({ hasText: /PICK/ })
        await picker.locator('button:has(svg.lucide-pencil)').first().click()
        const input = picker.getByPlaceholder('Enter path')
        await input.fill(dir)
        await input.press('Enter')
        await picker.getByRole('button', { name: /PICK CURRENT FOLDER/ }).click()
        const save = page.getByRole('dialog', { name: /Save File/ })
        await save.getByLabel('File name').fill('saved.txt')
        await save.getByRole('button', { name: 'Save' }).click()

        const sent = JSON.parse((await start).postData() ?? '{}') as {
            transfer: { operation: string; tags: string[]; request: { endpoint: string } }
        }
        expect(sent.transfer.tags).toEqual(['commander'])
        expect(sent.transfer.operation).toBe('download')
        expect(sent.transfer.request.endpoint).toBe('/job/batch')
        await expect.poll(() => existsSync(join(dir, 'saved.txt')), { timeout: 20_000 }).toBe(true)
        expect(readFileSync(join(dir, 'saved.txt'), 'utf8')).toBe('report')

        // In the Commander's own bar, as its drops are (by the name it has at the source).
        const bar = page.getByRole('region', { name: 'Page activity' })
        await bar.getByRole('button', { name: 'Show activity' }).click()
        await expect(bar.getByText('report.txt').first()).toBeVisible({ timeout: 10_000 })

        // And in Transfers, with the badge that says where it came from.
        await page.goto('/transfers')
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        const row = page.getByRole('tabpanel').getByRole('button').first()
        await expect(row).toContainText('report.txt')
        await expect(row).toContainText('Commander')
        await expect(row).not.toContainText('Operation')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a wrapper remote picks the remote it wraps from the file panel', async ({
    page,
    request,
}) => {
    await page.goto('/remotes')
    await page.locator('button:has(svg.lucide-plus)').first().click()
    await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-crypt')
    await page.getByPlaceholder('Select type or search').fill('crypt')
    await page.getByRole('option', { name: 'CRYPT', exact: true }).click()

    // The `remote` field carries the picker; pick the memory remote's root.
    await page.getByRole('button', { name: 'Pick a remote or folder' }).click()
    const picker = page.getByRole('dialog').filter({ hasText: 'PICK CURRENT FOLDER' })
    // Roots and remotes, but not the home/Desktop/Downloads shortcuts (no LOCAL_FS_EXTRA).
    await expect(picker.locator('svg.lucide-hard-drive').first()).toBeVisible()
    for (const shortcut of ['house', 'monitor', 'download', 'file-text']) {
        await expect(picker.locator(`svg.lucide-${shortcut}`)).toHaveCount(0)
    }
    await picker.locator('img[alt="memory"]').click()
    await expect(picker.getByText('e2e-memory')).toBeVisible()
    await picker.getByRole('button', { name: /PICK CURRENT FOLDER/ }).click()
    await expect(page.locator('#field-remote')).toHaveValue('e2e-memory:')

    await page.locator('#field-password').fill('e2e-secret')
    await page.getByRole('button', { name: 'Create Remote' }).click()
    await expect
        .poll(async () => {
            const response = await request.post('/api/rc/config/get', {
                headers: SESSION,
                data: { name: 'e2e-crypt' },
            })
            return response.ok()
                ? ((await response.json()) as { type?: string; remote?: string })
                : null
        })
        .toMatchObject({ type: 'crypt', remote: 'e2e-memory:' })
})

test('a combine remote is created from its upstreams field', async ({ page, request }) => {
    await page.goto('/remotes')
    await page.locator('button:has(svg.lucide-plus)').first().click()
    await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-combine')
    await page.getByPlaceholder('Select type or search').fill('combine')
    await page.getByRole('option', { name: 'COMBINE', exact: true }).click()

    // `upstreams` is a SpaceSepList, the backend's only required option: it must be a field.
    const upstreams = page.locator('#field-upstreams')
    await expect(upstreams).toBeVisible()
    await upstreams.fill('docs=e2e-memory:docs')
    await page.getByRole('button', { name: 'Create Remote' }).click()
    await expect
        .poll(async () => {
            const response = await request.post('/api/rc/config/get', {
                headers: SESSION,
                data: { name: 'e2e-combine' },
            })
            return response.ok()
                ? ((await response.json()) as { type?: string; upstreams?: string })
                : null
        })
        .toMatchObject({ type: 'combine', upstreams: 'docs=e2e-memory:docs' })

    // A SizeSuffix option offers the same presets the options editor has, and a typed value
    // that merely contains a preset ("6M" against "16M") is kept as typed when the user tabs on.
    await page.locator('button:has(svg.lucide-plus)').first().click()
    await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-chunker')
    await page.getByPlaceholder('Select type or search').fill('chunker')
    await page.getByRole('option', { name: 'CHUNKER', exact: true }).click()
    await page.locator('#field-remote').fill('e2e-memory:chunks')
    const chunkSize = page.locator('#field-chunk_size')
    await expect(chunkSize).toBeVisible()
    await chunkSize.focus()
    await expect(chunkSize).toBeFocused()
    await page.keyboard.press('End')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace') // "2Gi" → ""
    await page.keyboard.type('64')
    await expect(page.getByRole('option', { name: /^64M/ })).toBeVisible()
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('6M')
    await page.waitForTimeout(100)
    await page.keyboard.press('Tab')
    await expect(chunkSize).toHaveValue('6M')
    await page.getByRole('button', { name: 'Create Remote' }).click()
    await expect
        .poll(async () => {
            const response = await request.post('/api/rc/config/get', {
                headers: SESSION,
                data: { name: 'e2e-chunker' },
            })
            return response.ok() ? await response.json() : null
        })
        .toMatchObject({ type: 'chunker', remote: 'e2e-memory:chunks', chunk_size: '6M' })

    // The community build allows four remotes; leave room for the tests after this one.
    for (const name of ['e2e-combine', 'e2e-chunker']) {
        await request.post('/api/rc/config/delete', { headers: SESSION, data: { name } })
    }
})

test('a closed option list is a select that stores its choice', async ({ page, request }) => {
    await page.goto('/remotes')
    await page.locator('button:has(svg.lucide-plus)').first().click()
    await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-local')
    await page.getByPlaceholder('Select type or search').fill('local')
    await page.getByRole('option', { name: 'Local Disk' }).click()
    // Leave the type combobox once its list has gone: the drawer collapses the advanced section
    // whenever the type changes.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.getByPlaceholder('Remote name (for your reference)').click()
    await page.getByRole('button', { name: 'More Options' }).click()

    // `time_type` is rclone's `mtime|atime|btime|ctime` enum: a Select holding its default.
    const timeType = page.locator('#field-time_type')
    await expect(timeType).toHaveText(/mtime/)
    await timeType.click({ delay: 120 })
    await page.getByRole('option', { name: 'btime', exact: true }).click()
    await expect(timeType).toHaveText(/btime/)
    await page.getByRole('button', { name: 'Create Remote' }).click()
    await expect
        .poll(async () => {
            const response = await request.post('/api/rc/config/get', {
                headers: SESSION,
                data: { name: 'e2e-local' },
            })
            return response.ok() ? await response.json() : null
        })
        .toMatchObject({ type: 'local', time_type: 'btime' })
    await request.post('/api/rc/config/delete', {
        headers: SESSION,
        data: { name: 'e2e-local' },
    })
})

test('a path option browses from the folder it already points at', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-sa-'))
    writeFileSync(join(dir, 'token.json'), '{}')
    mkdirSync(join(dir, 'sub'))
    try {
        await page.goto('/remotes')
        await page.locator('button:has(svg.lucide-plus)').first().click()
        await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-drive')
        await page.getByPlaceholder('Select type or search').fill('drive')
        await page.getByRole('option', { name: 'Google Drive', exact: true }).click()

        // `service_account_file` is a local file path: the field carries a browse button that
        // opens the file panel in the folder of the current value.
        const field = page.locator('#field-service_account_file')
        await field.fill(join(dir, 'old.json'))
        await page.getByRole('button', { name: 'Browse for file' }).click()
        const dialog = page.getByRole('dialog').filter({ hasText: /0 SELECTED|PICK/ })
        const row = dialog.locator('[draggable]', { hasText: 'token.json' })
        await expect(row).toBeVisible()
        // A file pick must not hand back a folder: no "current folder" button, the confirm
        // button waits for a selection, and folder rows cannot be ticked.
        await expect(dialog.getByRole('button', { name: 'PICK CURRENT FOLDER' })).toHaveCount(0)
        await expect(dialog.getByRole('button', { name: '0 SELECTED' })).toBeDisabled()
        await expect(
            dialog.locator('[draggable]', { hasText: 'sub' }).getByRole('checkbox')
        ).toBeDisabled()
        // Opening a file's preview and clicking outside it must close only the preview, not
        // the picker underneath.
        await row.locator('span[title]').click()
        const preview = page.getByRole('dialog').filter({ hasText: 'token.json' }).last()
        await expect(preview).toBeVisible()
        // Three dialogs in the DOM: the Create Remote drawer, the picker, the preview (the
        // active modal hides the others from role queries, so count elements).
        await expect(page.locator('[role="dialog"]')).toHaveCount(3)
        await page.mouse.click(200, 450)
        await expect(page.locator('[role="dialog"]')).toHaveCount(2)
        await expect(row).toBeVisible()
        // HeroUI's checkbox input is a hidden overlay; a dispatched click toggles it like a real one.
        await row.getByRole('checkbox').dispatchEvent('click')
        await dialog.getByRole('button', { name: 'PICK', exact: true }).click()
        await expect(field).toHaveValue(join(dir, 'token.json'))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the header cog carries the tab theme and the language stub', async ({ page }) => {
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    await page.goto('/')
    const header = page.locator('header', {
        has: page.getByRole('button', { name: 'Toggle sidebar' }),
    })
    // The rclone version is the Dashboard's business; the header only has the cog.
    await expect(header.getByText(/^rclone \d+\.\d+/)).toHaveCount(0)

    // The theme applies to the tab at once.
    await header.getByRole('button', { name: 'Settings' }).click()
    const panel = page.getByRole('dialog', { name: 'Settings' })
    await panel.getByRole('button', { name: 'App Theme' }).click()
    await page.getByRole('option', { name: 'Light' }).click()
    await expect.poll(isDark).toBe(false)
    await panel.getByRole('button', { name: 'App Theme' }).click()
    await page.getByRole('option', { name: 'Dark' }).click()
    await expect.poll(isDark).toBe(true)

    // The language is a stub: picking another one says so and stays on English.
    await panel.getByRole('button', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Deutsch' }).click()
    const dialog = page.getByRole('dialog', { name: 'Coming soon' })
    await expect(dialog.getByText('Coming soon')).toBeVisible()
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(panel.getByRole('button', { name: 'Language' })).toContainText('English')
})

test("the Commander's shortcuts cog hides a disk from the sidebar", async ({ page }) => {
    await page.goto('/commander')
    const places = page.getByRole('navigation', { name: 'Places' })
    await expect(places.first()).toBeVisible()

    // The cog sits first on the bar below, not in a panel: what it hides goes from both sidebars.
    const cog = page.getByRole('button', { name: 'Shortcuts' })
    await expect(cog).toHaveCount(1)
    await cog.click()
    const panel = page.getByRole('dialog', { name: 'Shortcuts' })
    const first = panel.getByRole('switch').first()
    const labelId = (await first.getAttribute('aria-labelledby')) ?? ''
    const label = (await page.locator(`#${labelId}`).innerText()).trim()
    // HeroUI's switch input is a hidden overlay; a dispatched click toggles it like a real one.
    await first.dispatchEvent('click')
    await expect(first).not.toBeChecked()
    // The open panel hides the page behind it from the accessibility tree, so close it first.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(places.getByRole('button', { name: label, exact: true })).toHaveCount(0)

    // The choice is persisted: it holds across a reload, and turning it back on brings the disk back.
    await page.reload()
    await expect(places.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Shortcuts' }).click()
    await page
        .getByRole('dialog', { name: 'Shortcuts' })
        .getByRole('switch', { name: label, exact: true })
        .dispatchEvent('click')
    await page.keyboard.press('Escape')
    await expect(places.getByRole('button', { name: label, exact: true }).first()).toBeVisible()
})

test('the SMTP screen keeps its settings and never hands the password back', async ({
    page,
    request,
}) => {
    // The mail server every email notification goes through. Saved in a file of the server's
    // own (notifications/smtp.json), never in a state document: a page gets everything back
    // but the password, and only that one is saved is said.
    const smtp = async (name: string, data: Record<string, unknown> = {}) =>
        (await (await request.post(`/api/rpc/${name}`, { headers: SESSION, data })).json()) as {
            ok: boolean
            value?: Record<string, unknown>
            error?: string
        }
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Sidebar' })
    await nav.getByRole('link', { name: 'SMTP', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/smtp$/)
    await expect(page.getByRole('heading', { name: 'SMTP' })).toBeVisible()
    await expect(page.getByText('Coming soon')).toHaveCount(0)

    try {
        await page.getByLabel('Host', { exact: true }).fill('smtp.example.com')
        await page.getByLabel('Port', { exact: true }).fill('587')
        await page.getByLabel('Username', { exact: true }).fill('postmaster@example.com')
        await page.getByLabel('Password', { exact: true }).fill('hunter2')
        await page.getByLabel('From address', { exact: true }).fill('rclone-cloud@example.com')
        await page.getByLabel('From name', { exact: true }).fill('Backups')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByText('SMTP settings saved')).toBeVisible()

        // A reload reads the file back: every field but the password, which only says it is there.
        await page.reload()
        await expect(page.getByLabel('Host', { exact: true })).toHaveValue('smtp.example.com')
        await expect(page.getByLabel('Port', { exact: true })).toHaveValue('587')
        await expect(page.getByLabel('Username', { exact: true })).toHaveValue(
            'postmaster@example.com'
        )
        await expect(page.getByLabel('From name', { exact: true })).toHaveValue('Backups')
        const password = page.getByLabel('Password', { exact: true })
        await expect(password).toHaveValue('')
        await expect(password).toHaveAttribute('placeholder', 'Saved — leave empty to keep it')

        const view = await smtp('smtp_get')
        expect(view.value).toMatchObject({ host: 'smtp.example.com', hasPassword: true })
        expect(view.value).not.toHaveProperty('password')

        // Saved again with the password left empty, the saved one stays.
        await page.getByLabel('From name', { exact: true }).fill('Nightly')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByText('SMTP settings saved')).toBeVisible()
        expect((await smtp('smtp_get')).value).toMatchObject({
            fromName: 'Nightly',
            hasPassword: true,
        })
    } finally {
        await smtp('smtp_set', {
            settings: {
                host: '',
                port: 0,
                encryption: 'starttls',
                username: '',
                password: null,
                fromAddress: '',
                fromName: '',
            },
        })
    }
})

test('the notifications page offers Email where Telegram (botless) was', async ({ page }) => {
    // Every card is a provider that works, mailing through the SMTP settings in Email's case;
    // there is no placeholder for one that does not exist yet.
    await page.goto('/settings/notifications')
    await expect(page.getByText('Telegram (botless)')).toHaveCount(0)
    await expect(page.getByText('WhatsApp', { exact: true })).toHaveCount(0)
    await page.locator('[data-provider="email"]').click()
    await expect(page.getByRole('dialog', { name: 'Add Email' })).toBeVisible()
    await expect(page.getByLabel('Send to', { exact: true })).toBeVisible()
    // Without SMTP settings the drawer says what to do first, and where.
    await expect(page.getByText('Set up SMTP first')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send Test' })).toBeDisabled()
})

test("the operation footer's templates button names itself on hover", async ({ page }) => {
    // Every other icon button in the bar says what it is on hover; this one did not. It is a
    // dropdown trigger, so the tooltip has to sit around the trigger without displacing it.
    await page.goto('/copy')
    // The blocked START button wears the same icon; the dropdown trigger is the one with a menu.
    const templates = page.locator('button[aria-haspopup="true"]:has(svg.lucide-folders)')
    await expect(templates).toBeVisible()
    // The very first pointer move onto a freshly loaded page is missed by every tooltip in this
    // bar, the dry-run one included, so hover until it takes rather than once.
    await expect(async () => {
        await page.mouse.move(0, 0)
        await templates.hover()
        await expect(page.getByRole('tooltip')).toHaveText('Templates', { timeout: 2000 })
    }).toPass({ timeout: 15_000 })
    // Still a dropdown: the tooltip must not have swallowed the trigger on its way in.
    await templates.click()
    await expect(page.getByRole('menu')).toBeVisible()
})

test('the serve address field and the addr flag are one value', async ({ page }) => {
    // Every serve type needs a listen address, and it lived only in the Serve options JSON. The
    // field is that same flag in plain sight: whichever side is typed into, both carry it.
    await page.goto('/serve')
    await page.getByRole('button', { name: 'Type' }).click()
    await page.getByRole('option', { name: 'HTTP', exact: true }).click()
    const address = page.getByLabel('Address', { exact: true })
    await address.fill('127.0.0.1:9999')
    // The Serve section is the one with the server icon; Type is a select, not an accordion.
    await page.locator('button:has(svg.lucide-server-crash)').click()
    const options = page
        .getByRole('region', { name: /Serve/ })
        .getByRole('textbox', { name: 'Custom Options' })
    await expect(options).toHaveValue(/"addr": "127\.0\.0\.1:9999"/)
    // And back: the flag is the value, the field only shows it.
    await options.fill('{\n  "addr": "0.0.0.0:8080"\n}')
    await expect(address).toHaveValue('0.0.0.0:8080')
    // Clearing the field takes the flag out rather than leaving an empty one behind.
    await address.fill('')
    await expect(options).not.toHaveValue(/addr/)
    // With a source and an address the page has what it needs to start.
    await address.fill('127.0.0.1:9999')
    await page.getByLabel('Source', { exact: true }).fill('/tmp')
    await expect(page.getByRole('button', { name: 'START SERVE' })).toBeVisible()
})

test('a started serve offers the address rclone is really listening on', async ({
    page,
    request,
}) => {
    const rc = async (path: string, data: Record<string, unknown> = {}) =>
        (await request.post(`/api/rc/${path}`, { headers: SESSION, data })).json()
    const running = async () =>
        ((await rc('serve/list')) as { list?: { id: string; addr: string }[] }).list ?? []
    const before = (await running()).map((serve) => serve.id)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    try {
        await page.goto('/serve')
        await page.getByRole('button', { name: 'Type' }).click()
        await page.getByRole('option', { name: 'HTTP', exact: true }).click()
        // Port 0: rclone picks one, so the field's text is not the address to hand out.
        await page.getByLabel('Address', { exact: true }).fill('127.0.0.1:0')
        await page.getByLabel('Source', { exact: true }).fill('e2e-memory:')
        await page.getByRole('button', { name: 'START SERVE' }).click()

        await expect(page.getByRole('button', { name: 'NEW SERVE' })).toBeVisible({
            timeout: 15_000,
        })
        await page.getByRole('button', { name: 'COPY ADDRESS' }).click()
        const started = (await running()).find((serve) => !before.includes(serve.id))
        expect(started?.addr).toMatch(/^127\.0\.0\.1:[1-9]\d*$/)
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(started?.addr)
    } finally {
        for (const serve of await running()) {
            if (!before.includes(serve.id)) await rc('serve/stop', { id: serve.id })
        }
    }
})

test("an operation page links to rclone's documentation for its command", async ({ page }) => {
    const commands = {
        copy: 'copy',
        move: 'move',
        sync: 'sync',
        bisync: 'bisync',
        delete: 'delete',
        purge: 'purge',
        mount: 'mount',
        serve: 'serve',
        download: 'copyurl',
    }
    for (const [route, command] of Object.entries(commands)) {
        await page.goto(`/${route}`)
        const docs = page.locator('a:has(svg.lucide-book-open-text)')
        await expect(docs).toHaveAttribute('href', `https://rclone.org/commands/rclone_${command}/`)
        await expect(docs).toHaveAttribute('target', '_blank')
    }
})

test("the transfers list shows each running transfer's speed", async ({ page, request }) => {
    // A 4 MB copy to the memory remote at 256 KB/s stays active for about 16 seconds. The limit
    // is the daemon's global one (a per-call `_config` limit is not honoured), so it is reset.
    // Started the way the app starts one: the list is the server's record, and rclone is only
    // asked for the live numbers of what that record says is running.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-speed-'))
    writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(4 * 1024 * 1024))
    const bwlimit = (rate: string) =>
        request.post('/api/rc/core/bwlimit', { headers: SESSION, data: { rate } })
    await bwlimit('256k')
    const started = (await (
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: {
                transfer: {
                    operation: 'copy',
                    sources: [dir],
                    destination: 'e2e-memory:speed',
                    request: {
                        endpoint: '/job/batch',
                        body: {
                            inputs: [{ _path: 'sync/copy', srcFs: dir, dstFs: 'e2e-memory:speed' }],
                        },
                    },
                },
            },
        })
    ).json()) as { ok: boolean; value: { id: string } }
    expect(started.ok).toBe(true)
    try {
        await page.goto('/transfers')
        // No refreshing: the row is there from the start and its numbers poll while it runs.
        await expect(page.getByText(/\d[\d.]* [KMG]i?B\/s/)).toBeVisible({ timeout: 10_000 })

        // Stopped through the server, it is recorded as stopped — not as the failure the
        // "context canceled" it ends with would read as. The open drawer follows its row.
        await page.locator('button:has(svg.lucide-chevron-right)').last().click()
        const drawer = page.getByRole('dialog')
        await drawer.locator('button:has(svg.lucide-square)').click()
        await expect(drawer.getByText('STOPPED')).toBeVisible({ timeout: 10_000 })
        const list = (await (
            await request.post('/api/rpc/transfers_list', {
                headers: SESSION,
                data: {},
            })
        ).json()) as { value: { id: string; state: string }[] }
        expect(list.value.find((entry) => entry.id === started.value.id)?.state).toBe('stopped')
    } finally {
        await request.post('/api/rpc/transfers_stop', {
            headers: SESSION,
            data: { id: started.value.id },
        })
        // The daemon's lifetime counters would otherwise keep a speed and a failed job around.
        await request.post('/api/rc/core/stats-reset', { headers: SESSION, data: {} })
        await bwlimit('off')
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the wizard hands its plan to the operation page', async ({ page }) => {
    await page.goto('/wizard')
    const plan = page.getByLabel('Plan', { exact: true })
    const question = (text: string) => page.getByRole('heading', { name: text })
    const pick = (text: string) =>
        page.getByRole('button', { name: new RegExp(`^${text}`) }).click()
    const next = page.getByRole('button', { name: 'Continue' })
    // The panel under the options is absent on the first step and present from the second on.
    const info = page.getByRole('complementary', { name: 'About this step' })
    await expect(question('What do you want to do?')).toBeVisible()
    await expect(info).toBeHidden()
    await pick('Copy or move files')
    await expect(question('What happens to the originals?')).toBeVisible()
    await expect(info).toBeVisible()
    // Back onto step 1 is a fresh start: no count, no pick, the opening prompt.
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByText(/^Step 1$/)).toBeVisible()
    await expect(plan).toHaveText(/^Say what you want to do/)
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(0)
    await pick('Copy or move files')
    await pick('Keep them')
    // The sentence at the top fills in as the answers arrive.
    await expect(plan).toHaveText(/^Copy the files in somewhere to somewhere/)
    await expect(question('Where are the files, and where should they go?')).toBeVisible()
    await expect(next).toBeDisabled()
    await page.getByLabel('Where are the files now?', { exact: true }).fill('/tmp/e2e-src')
    await expect(next).toBeDisabled()
    await page.getByLabel('Where should they go?', { exact: true }).fill('/tmp/e2e-dst')
    // Back keeps the answers: the pick stays highlighted and Continue moves on again.
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('button', { name: /^Keep them/ })).toHaveAttribute(
        'aria-pressed',
        'true'
    )
    await next.click()
    await expect(page.getByLabel('Where are the files now?', { exact: true })).toHaveValue(
        '/tmp/e2e-src'
    )
    await next.click()
    // Whether the files' metadata comes along, asked where it moves (a share is not asked, below).
    // "Yes, with changes" opens the mapping panel on the step, and waits for a whole rule.
    await expect(question('Should the files’ metadata come along?')).toBeVisible()
    await expect(info).toBeVisible()
    await pick('Yes, with changes')
    const panel = page.getByRole('region', { name: 'Metadata mapping', exact: true })
    await expect(panel).toBeVisible()
    await expect(next).toBeDisabled()
    await panel.getByLabel('From', { exact: true }).fill('mtime')
    await page.getByRole('option', { name: 'mtime' }).click()
    await expect(next).toBeDisabled()
    await panel.getByLabel('To', { exact: true }).fill('modified')
    await expect(plan).toHaveText(
        /^Copy the files in \/tmp\/e2e-src to \/tmp\/e2e-dst, metadata mapped/
    )
    await next.click()
    await expect(question('When should it run?')).toBeVisible()
    await pick('Every day')
    await expect(question('Keep these settings for next time?')).toBeVisible()
    await pick('Just this once')
    await expect(question('Your plan')).toBeVisible()
    await expect(plan).toHaveText(
        'Copy the files in /tmp/e2e-src to /tmp/e2e-dst, metadata mapped, every day at 2:00.'
    )
    // Change edits one answer and comes straight back; Back to plan leaves the plan as it was.
    const change = (row: string) =>
        page.locator('dl > div', { hasText: row }).getByRole('button', { name: 'Change' }).click()
    await change('When')
    await expect(page.getByText('Changing your plan')).toBeVisible()
    await pick('Every hour')
    await expect(question('Your plan')).toBeVisible()
    const sentence = 'Copy the files in /tmp/e2e-src to /tmp/e2e-dst, metadata mapped, every hour.'
    await expect(plan).toHaveText(sentence)
    await change('When')
    await pick('Custom')
    await page.getByRole('button', { name: 'Back to plan' }).click()
    await expect(plan).toHaveText(sentence)
    // The mapping is kept with the answer: changing it finds the rule where it was left.
    await expect(page.locator('dl > div', { hasText: 'Metadata' })).toContainText(
        'Yes, with 1 rule'
    )
    await change('Metadata')
    await expect(page.getByRole('button', { name: /^Yes, with changes/ })).toHaveAttribute(
        'aria-pressed',
        'true'
    )
    await expect(panel.getByLabel('From', { exact: true })).toHaveValue('mtime')
    await page.getByRole('button', { name: 'Back to plan' }).click()
    // The operation is chosen over steps 1 and 2; the places survive a Copy → Move switch.
    await change('Operation')
    await expect(page.getByRole('button', { name: /^Copy or move files/ })).toHaveAttribute(
        'aria-pressed',
        'true'
    )
    await expect(page.getByRole('button', { name: 'Back to plan' })).toBeVisible()
    await pick('Copy or move files')
    await expect(question('What happens to the originals?')).toBeVisible()
    await pick('Take them away')
    await expect(plan).toHaveText(
        'Move the files in /tmp/e2e-src to /tmp/e2e-dst, metadata mapped, every hour.'
    )
    await change('Operation')
    await pick('Copy or move files')
    await pick('Keep them')
    await expect(plan).toHaveText(sentence)
    // The plan opens the Copy page with the places, the schedule and the mapping already in.
    await page.getByRole('button', { name: 'Open Copy' }).click()
    await expect(page).toHaveURL(/\/copy\?preset=/)
    await expect(page.getByLabel('Destination')).toHaveValue('/tmp/e2e-dst')
    await expect(page.getByRole('button', { name: 'START AND SCHEDULE COPY' })).toBeVisible()
    const metadata = await openMetadataSection(page)
    await expect
        .poll(async () =>
            JSON.parse(await metadata.getByRole('textbox', { name: 'Custom Options' }).inputValue())
        )
        .toMatchObject({
            metadata: true,
            metadata_mapper: [
                expect.stringContaining('rclone-cloud'),
                'metadata-map',
                '--map',
                'mtime=modified',
            ],
        })
    await expect(panel.getByLabel('From', { exact: true })).toHaveValue('mtime')
    // A share has one place, nothing to schedule, and names the protocol in plain words.
    await page.goto('/wizard')
    await pick('Serve files over the network')
    await expect(question('How will others connect?')).toBeVisible()
    await pick('In a browser')
    await expect(question('What should be shared?')).toBeVisible()
    await page.getByLabel('Folder', { exact: true }).fill('/tmp/e2e-share')
    await next.click()
    await expect(question('Keep these settings for next time?')).toBeVisible()
    await pick('Just this once')
    await expect(plan).toHaveText('Share /tmp/e2e-share over HTTP.')
    await page.getByRole('button', { name: 'Open Serve' }).click()
    await expect(page).toHaveURL(/\/serve\?preset=/)
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('/tmp/e2e-share')
})

test('a finished job reopens its page with the same settings', async ({ page, request }) => {
    // The Copy page records what it submits; the job drawer offers it back as a new operation.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-reuse-'))
    writeFileSync(join(dir, 'note.txt'), 'hello')
    const preset = encodePreset({
        operation: 'copy',
        args: {
            // A folder source ends in a slash, as the pickers write it; filters need one.
            sources: [`${dir}/`],
            destination: 'e2e-memory:reuse',
            options: { filter: { max_size: '10M' } },
        },
    })
    try {
        await page.goto(`/copy?preset=${preset}`)
        await expect(page.getByLabel('Destination')).toHaveValue('e2e-memory:reuse')
        await page.getByRole('button', { name: 'START COPY' }).click()
        await expect(page.getByRole('button', { name: 'NEW COPY' })).toBeVisible({
            timeout: 15_000,
        })
        // What it was started with is kept with the transfer, by the server: the page that
        // started it can be long gone.
        const kept = async () => {
            const list = (await (
                await request.post('/api/rpc/transfers_list', {
                    headers: SESSION,
                    data: {},
                })
            ).json()) as {
                value: {
                    state: string
                    destination: string | null
                    preset: unknown
                    tags: string[]
                }[]
            }
            const entry = list.value.find((entry) => entry.destination === 'e2e-memory:reuse')
            // Started from an operation's page, which is what its record says.
            if (entry) expect(entry.tags).toEqual(['operation'])
            return entry?.state
        }
        await expect.poll(kept, { timeout: 15_000 }).toBe('completed')
        await page.goto('/transfers')
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        await expect(page.getByRole('tabpanel').getByRole('button').first()).toContainText(
            'Operation'
        )
        // Newest first: the transfer that just ended is the top row.
        await page
            .getByRole('tabpanel')
            .locator('button:has(svg.lucide-chevron-right)')
            .first()
            .click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByText(/Transfer Details #\d+/)).toBeVisible()
        await expect(dialog.getByText('FINISHED')).toBeVisible()
        // A finished transfer is read from the record: its files are there with no rclone call.
        await expect(dialog.getByText('note.txt')).toBeVisible()
        await dialog.getByRole('button', { name: 'Reuse settings' }).click()
        await expect(page).toHaveURL(/\/copy\?preset=/)
        await expect(page.getByLabel('Destination')).toHaveValue('e2e-memory:reuse')
        await page.getByRole('button', { name: /Filters/ }).click()
        await expect(
            page.getByRole('region', { name: /Filters/ }).getByRole('textbox', {
                name: 'Custom Options',
            })
        ).toHaveValue(/"max_size": "10M"/)
    } finally {
        await request.post('/api/rc/core/stats-reset', { headers: SESSION, data: {} })
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the picker renames and deletes files in place', async ({ page }) => {
    // The path picker is the Commander's panel: its rows carry the same rename and delete.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-pick-'))
    writeFileSync(join(dir, 'draft.txt'), 'a')
    writeFileSync(join(dir, 'old.txt'), 'b')
    try {
        await page.goto(presetRoute({ operation: 'copy', args: { sources: [dir] } }))
        await page.locator('button:has(svg.lucide-folder-open)').first().click()
        const picker = page.getByRole('dialog').filter({ hasText: /0 SELECTED|PICK/ })
        const row = (name: string) => picker.locator('[draggable]', { hasText: name })
        await expect(row('draft.txt')).toBeVisible()
        // Rename from the row's hover button: the prompt takes the new name.
        await row('draft.txt').locator('button:has(svg.lucide-pencil)').click()
        const renamePrompt = page.getByRole('dialog').filter({ hasText: 'Enter a new name' })
        await renamePrompt.getByRole('textbox').fill('final.txt')
        await renamePrompt.getByRole('button', { name: /^ok$/i }).click()
        await expect(row('final.txt')).toBeVisible()
        expect(existsSync(join(dir, 'final.txt'))).toBe(true)
        expect(existsSync(join(dir, 'draft.txt'))).toBe(false)
        // Delete a ticked file: it goes from the disk and from the selection.
        await row('old.txt').getByRole('checkbox').dispatchEvent('click')
        await expect(picker.getByRole('button', { name: 'PICK (1)' })).toBeVisible()
        await row('old.txt').locator('button:has(svg.lucide-trash-2)').click()
        const confirm = page.getByRole('dialog').filter({ hasText: 'Confirm Delete' })
        await confirm.getByRole('button', { name: 'Yes' }).click()
        // The disk first: while the confirm is closing, the picker is hidden from role queries
        // and a "row gone" check would pass before the delete has run.
        await expect.poll(() => existsSync(join(dir, 'old.txt'))).toBe(false)
        await expect(picker.getByRole('button', { name: '0 SELECTED' })).toBeVisible()
        await expect(row('old.txt')).toHaveCount(0)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a backend whose type is not its prefix still gets its icon', async ({ page, request }) => {
    // Icons are named after the rclone type, which is what every configured remote carries.
    // Three types are not their prefix and two of those hold spaces, so the request for one
    // arrives percent-encoded and the server has to decode it back to the file name.
    await request.post('/api/rc/config/create', {
        headers: SESSION,
        data: {
            name: 'e2e-gcs',
            type: 'google cloud storage',
            parameters: {},
            opt: { nonInteractive: true },
        },
    })
    try {
        const asset = await request.get('/icons/backends/google cloud storage.png')
        expect(asset.status()).toBe(200)
        expect(asset.headers()['content-type']).toContain('image/png')
        await page.goto('/commander')
        const icon = page
            .getByRole('navigation', { name: 'Places' })
            .first()
            .locator('img[alt="google cloud storage"]')
        await expect(icon).toBeVisible({ timeout: 15_000 })
        // A name the server cannot resolve comes back as the SPA fallback, and an <img> given
        // HTML paints nothing: that it has width is the proof the real file was served.
        await expect
            .poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth))
            .toBeGreaterThan(0)
        // The create list draws the same file, off the backend rather than off a remote.
        await page.goto('/remotes')
        await page.locator('button:has(svg.lucide-plus)').first().click()
        await page.getByPlaceholder('Select type or search').fill('google cloud')
        const listed = page.getByRole('option').first().locator('img')
        await expect(listed).toHaveAttribute('alt', 'google cloud storage')
        await expect
            .poll(() => listed.evaluate((img: HTMLImageElement) => img.naturalWidth))
            .toBeGreaterThan(0)
    } finally {
        await request.post('/api/rc/config/delete', {
            headers: SESSION,
            data: { name: 'e2e-gcs' },
        })
    }
})

test("the commander spends the action column's spare width on the name", async ({ page }) => {
    // Two panels and their rails leave the Name column short, and the icons that appear on hover
    // never filled their 11rem. The column is 8rem now; Name is the 1fr, so it takes the rest.
    // The icons do overhang the column at that width, but into Last Modified's trailing space:
    // what has to hold is that they clear the date itself, even the longest one it can print,
    // and with the extra icon a public-link remote adds.
    await page.setViewportSize({ width: 1500, height: 800 })
    await page.goto('/commander')
    const row = page.locator('[draggable]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()
    const measured = await row.evaluate((el) => {
        const cells = [...el.children] as HTMLElement[]
        const actions = cells[cells.length - 1]
        const modified = cells[cells.length - 2]
        const icons = [...actions.querySelectorAll('button')] as HTMLElement[]
        // `formatModTime` prints "Mon D, YYYY"; measure the widest of those in the cell's font.
        const style = getComputedStyle(modified)
        const probe = document.createElement('span')
        probe.style.position = 'absolute'
        probe.style.visibility = 'hidden'
        probe.style.whiteSpace = 'nowrap'
        probe.style.font = `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`
        probe.style.letterSpacing = style.letterSpacing
        document.body.append(probe)
        const months = [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
        ]
        let widestDate = 0
        for (const month of months) {
            probe.textContent = `${month} 28, 2026`
            widestDate = Math.max(widestDate, probe.getBoundingClientRect().width)
        }
        probe.remove()
        const dateEnd = modified.getBoundingClientRect().left + widestDate
        const firstIcon = icons[0]?.getBoundingClientRect().left ?? 0
        const oneMore =
            (icons[0]?.getBoundingClientRect().width ?? 0) +
            Number.parseFloat(getComputedStyle(actions).columnGap)
        return {
            name: cells[1].getBoundingClientRect().width,
            actions: actions.getBoundingClientRect().width,
            icons: icons.length,
            clearance: firstIcon - dateEnd,
            // A remote that makes public links shows a fifth icon (Share); this is that row.
            clearanceWithShare: firstIcon - oneMore - dateEnd,
        }
    })
    expect(measured.actions).toBeCloseTo(8 * 16, 1)
    expect(measured.name).toBeGreaterThan(225)
    // ~41px of room against the longest date with the four a local folder shows, and the row
    // that carries five (Share, on a remote that makes public links) still clears it by ~7px.
    expect(measured.clearance, `${measured.icons} icons`).toBeGreaterThan(24)
    expect(measured.clearanceWithShare, `${measured.icons} icons + share`).toBeGreaterThan(0)
})

test('a favourite row shows its full path and carries the star alone', async ({
    page,
    request,
}) => {
    // Favourites are bookmarks, not a folder: rename, download and delete would reach through
    // to the real path from a list that is only meant to point at it. Dropping the bookmark is
    // the one thing a row does here.
    const doc = async () =>
        (await (await request.get('/api/state/app', { headers: SESSION })).json()) as {
            revision: number
        }
    const before = await doc()
    await request.patch('/api/state/app', {
        headers: { ...SESSION, 'If-Match': String(before.revision) },
        data: {
            set: { favoritePaths: [{ remote: 'e2e-memory', path: 'keep/', added: 1 }] },
            unset: [],
        },
    })
    try {
        await page.goto('/commander')
        const places = page.getByRole('navigation', { name: 'Places' }).first()
        await expect(places).toBeVisible()
        await places.locator('button:has(svg.lucide-star)').click()
        const row = page.locator('[draggable]', { hasText: '(e2e-memory) keep' })
        await expect(row).toBeVisible()
        for (const icon of ['pencil', 'trash-2', 'download', 'share-2']) {
            await expect(row.locator(`button:has(svg.lucide-${icon})`), icon).toHaveCount(0)
        }
        // A favourite is labelled "(remote) name", so hovering the row is the only place the
        // path it points at shows up.
        await row.hover()
        await expect(page.getByRole('tooltip')).toHaveText('e2e-memory:keep/')
        // The star is the row's only action, and it takes the favourite off the list.
        const star = row.locator('button:has(svg.lucide-star)')
        await expect(star).toHaveCount(1)
        await star.click()
        await expect(row).toHaveCount(0)
    } finally {
        const after = await doc()
        await request.patch('/api/state/app', {
            headers: { ...SESSION, 'If-Match': String(after.revision) },
            data: { set: { favoritePaths: [] }, unset: [] },
        })
    }
})

test('a folder that disappeared shows its cached rows until a refresh, then the error and nothing else', async ({
    page,
}) => {
    // A listing is served from memory for a while (`components/navigator/listing.ts`), so a
    // folder removed behind the app's back still shows its rows on the next visit. The refresh
    // asks rclone, which fails: the error, and no rows, on this visit and the next.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-gone-'))
    writeFileSync(join(dir, 'kept.txt'), 'a')
    try {
        await page.goto(presetRoute({ operation: 'copy', args: { sources: [dir] } }))
        await page.locator('button:has(svg.lucide-folder-open)').first().click()
        const picker = page.getByRole('dialog').filter({ hasText: /0 SELECTED|PICK/ })
        const kept = picker.locator('[draggable]', { hasText: 'kept.txt' })
        await expect(kept).toBeVisible()

        // The path bar's pencil is the first one in the panel; the rows' own pencils come later.
        const goTo = async (path: string) => {
            await picker.locator('button:has(svg.lucide-pencil)').first().click()
            const input = picker.getByPlaceholder('Enter path')
            await input.fill(path)
            await input.press('Enter')
        }

        // Away, so the folder's rows live only in the cache, then off the disk it goes.
        await goTo(tmpdir())
        await expect(kept).toHaveCount(0)
        rmSync(dir, { recursive: true, force: true })

        // Back to it: the rows are the cached ones. Refresh: the listing fails, and the cached
        // rows must not survive the failure.
        await goTo(dir)
        await expect(kept).toBeVisible()
        await picker.locator('button:has(svg.lucide-refresh-cw)').click()
        await expect(picker.getByText('No access or folder does not exist')).toBeVisible()
        await expect(kept).toHaveCount(0)
        // The next visit asks again, rather than showing what was there before the failure.
        await goTo(tmpdir())
        await goTo(dir)
        await expect(picker.getByText('No access or folder does not exist')).toBeVisible()
        await expect(kept).toHaveCount(0)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a path reads the way rclone reads it, in the path bar and in a field', async ({
    page,
    request,
}) => {
    // The app used to know a remote path by the `:/` the file panel wrote into every path it
    // handed out; `remote:folder`, rclone's own spelling, was a local folder to the path bar.
    // Now the one grammar is rclone's, and what it would refuse is said instead of sent.
    const upload = await request.post(
        '/api/rc/operations/uploadfile?fs=e2e-memory:&remote=grammar',
        {
            headers: { 'X-RcloneCloud-Client': 'web' },
            multipart: {
                file0: { name: 'inner.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
            },
        }
    )
    expect(upload.ok()).toBe(true)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto('/commander')
    // The left panel's path bar: its pencil is the page's first; the input exists while editing.
    const goTo = async (path: string) => {
        await page.locator('button:has(svg.lucide-pencil)').first().click()
        const input = page.getByPlaceholder('Enter path')
        await input.fill(path)
        await input.press('Enter')
    }
    // rclone's spelling, no slash: the remote, and the folder under its root.
    await goTo('e2e-memory:grammar')
    const inner = page.locator('[draggable]', { hasText: 'inner.txt' }).first()
    await expect(inner).toBeVisible({ timeout: 15_000 })
    // What the panel hands out is what it was given: no slash put in.
    await expect(page.locator('span[title="e2e-memory:grammar/inner.txt"]')).toHaveCount(1)
    // A name rclone would refuse is an error in the panel, and the panel stays where it was.
    await goTo('-bad:x')
    await expect(page.getByText(/‘-bad’ cannot be a remote name/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'grammar' })).toBeVisible()
    // A drive path on a host without drives: rclone would read the remote C, so say so.
    await goTo('C:\\Users\\me')
    await expect(page.getByText(/This host is not Windows, so C: would be read/)).toBeVisible()
    // The place entered again: the rows are back.
    await goTo('e2e-memory:grammar')
    await expect(inner).toBeVisible()
    await expect(page.getByText(/This host is not Windows/)).toHaveCount(0)

    // The same word next to a Copy field, and on the start button until it is fixed.
    await page.goto('/copy')
    await page.getByLabel('Source', { exact: true }).fill('-bad:x')
    await page.getByLabel('Destination', { exact: true }).fill('/tmp')
    await expect(page.getByText(/‘-bad’ cannot be a remote name/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Fix the source path' })).toBeDisabled()
    await page.getByLabel('Source', { exact: true }).fill('e2e-memory:grammar/')
    await expect(page.getByRole('button', { name: 'START COPY' })).toBeEnabled()
})

test('a folder typed without a slash is a folder: rclone says so, not the spelling', async ({
    page,
    request,
}) => {
    // The picker used to end every folder in `/`, and the builders read that to choose
    // `sync/copy` over `copyfile`; a folder typed by hand went out as a file and rclone answered
    // "is a directory not a file". Now the start asks rclone what each source is (the stat it
    // already made to say "does not exist") and the spelling is the user's.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-kinds-'))
    writeFileSync(join(dir, 'inside.txt'), 'inside')
    const name = basename(dir)
    const list = async (remote: string) =>
        (await (
            await request.post('/api/rc/operations/list', {
                headers: SESSION,
                data: { fs: 'e2e-memory:', remote },
            })
        ).json()) as { list?: { Name: string }[] }
    try {
        await page.goto('/copy')
        await page.getByLabel('Source', { exact: true }).fill(dir)
        await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:kinds')
        await page.getByRole('button', { name: 'START COPY' }).click()
        await expect(page.getByRole('button', { name: 'NEW COPY' })).toBeVisible({
            timeout: 15_000,
        })
        await expect
            .poll(async () => (await list(`kinds/${name}`)).list?.map((item) => item.Name) ?? [])
            .toEqual(['inside.txt'])

        // And a file typed with a slash is a file.
        await page.goto('/copy')
        await page.getByLabel('Source', { exact: true }).fill(`${dir}/inside.txt/`)
        await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:kinds/as-file')
        await page.getByRole('button', { name: 'START COPY' }).click()
        await expect(page.getByRole('button', { name: 'NEW COPY' })).toBeVisible({
            timeout: 15_000,
        })
        await expect
            .poll(async () => (await list('kinds/as-file')).list?.map((item) => item.Name) ?? [])
            .toEqual(['inside.txt'])

        // Purge takes folders only, and says so by name before rclone is asked.
        await page.goto('/purge')
        await page.getByLabel('Path(s)', { exact: true }).fill(`${dir}/inside.txt`)
        await page.getByRole('button', { name: 'START PURGE' }).click()
        await expect(page.getByRole('dialog')).toContainText(
            `${dir}/inside.txt is a file; only folders can be purged`
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
        await request.post('/api/rc/operations/purge', {
            headers: SESSION,
            data: { fs: 'e2e-memory:', remote: 'kinds' },
        })
    }
})

test('the picker hands a folder over as it is, no slash added', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-pick-'))
    try {
        // The destination's picker (one path, so the current folder can be picked as it is).
        await page.goto('/copy')
        await page.locator('button:has(svg.lucide-folder-open)').nth(1).click()
        const picker = page.getByRole('dialog').filter({ hasText: /0 SELECTED|PICK/ })
        await picker.locator('button:has(svg.lucide-pencil)').first().click()
        const input = picker.getByPlaceholder('Enter path')
        await input.fill(dir)
        await input.press('Enter')
        await picker.getByRole('button', { name: /PICK CURRENT FOLDER/ }).click()
        await expect(page.getByLabel('Destination', { exact: true })).toHaveValue(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a scheduled task keeps what its sources are, and its task file is built from that', async ({
    page,
    request,
}) => {
    // The task file's requests are built once, when the task is saved, and a run only submits
    // them; a later save (enable, a cron edit, a remote rename) rebuilds them without asking
    // rclone again, so what the sources are has to be kept with the task.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-sched-'))
    writeFileSync(join(dir, 'a.txt'), 'a')
    type Task = { id: string; kinds?: Record<string, string> }
    // The list carries each task's form under `task`; the id is beside it.
    const schedules = async () =>
        (
            (await (
                await request.post('/api/rpc/scheduler_list', { headers: SESSION, data: {} })
            ).json()) as { value: { id: string; task: Omit<Task, 'id'> }[] }
        ).value.map((listed): Task => ({ id: listed.id, ...listed.task }))
    let taskId: string | undefined
    try {
        await page.goto('/copy')
        await page.getByLabel('Source', { exact: true }).fill(dir)
        await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:sched')
        const nudge = page.getByText('Show more options')
        if (await nudge.isVisible()) await nudge.dispatchEvent('click')
        await page.getByRole('button', { name: /Schedule/ }).click()
        await page.getByPlaceholder(/Enter cron expression/).fill('0 2 * * *')
        await page.getByRole('button', { name: 'START AND SCHEDULE COPY' }).click()
        const namePrompt = page.getByRole('dialog').filter({ hasText: 'Schedule Name' })
        await namePrompt.getByRole('textbox').fill('e2e kinds')
        await namePrompt.getByRole('button', { name: /^ok$/i }).click()
        await expect(page.getByRole('button', { name: 'NEW COPY' })).toBeVisible({
            timeout: 15_000,
        })
        const saved = async () => (await schedules()).find((t) => t.kinds?.[dir] !== undefined)
        await expect.poll(saved).toBeDefined()
        const task = (await saved())!
        taskId = task.id
        expect(task.kinds).toEqual({ [dir]: 'folder' })
        const taskFile = join('e2e', '.tmp', 'open', 'scheduler', 'tasks', `${taskId}.json`)
        const file = JSON.parse(readFileSync(taskFile, 'utf8')) as {
            spec: { requests: { body: { inputs: { _path: string; srcFs: string }[] } }[] }
        }
        expect(file.spec.requests[0].body.inputs[0]).toMatchObject({
            _path: 'sync/copy',
            srcFs: `:local:${dir}/`,
        })
    } finally {
        if (taskId) {
            await request.post('/api/rpc/scheduler_remove', {
                headers: SESSION,
                data: { taskId },
            })
        }
        rmSync(dir, { recursive: true, force: true })
        await request.post('/api/rc/operations/purge', {
            headers: SESSION,
            data: { fs: 'e2e-memory:', remote: 'sched' },
        })
    }
})

test('a new OAuth login stops a stuck one, and cancelling stops its own', async ({
    page,
    request,
}) => {
    // The sign-in dialog's Copy link writes to the clipboard, and the assertion reads it back.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const rc = (path: string, data: Record<string, unknown>, timeout?: number) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data, timeout })
    const status = async () =>
        (await (await rc('config/oauthstatus', {})).json()) as {
            status: string
            authUrl?: string
        }
    const remotes = async () =>
        ((await (await rc('config/listremotes', {})).json()) as { remotes?: string[] }).remotes ??
        []
    // A login somebody walked away from: rclone's auth server keeps running and holds its port.
    // The create call blocks until the login completes, so it is not awaited; it ends when the
    // page stops the stray server, with an error.
    const stray = rc(
        'config/create',
        {
            name: 'e2e-stray',
            type: 'drive',
            parameters: { client_id: 'x', client_secret: 'y', config_auth_no_browser: true },
        },
        0
    ).then(
        (response) => response.ok(),
        () => false
    )
    try {
        await expect.poll(async () => (await status()).status).toBe('running')
        const strayUrl = (await status()).authUrl
        expect(strayUrl).toBeTruthy()
        // rclone wrote the stray's section before its login, without a token, and the Remotes
        // page would offer to reconnect it. The login server runs on regardless of the section.
        await rc('config/delete', { name: 'e2e-stray' })

        await page.goto('/remotes')
        await page.locator('button:has(svg.lucide-plus)').first().click()
        await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-oauth')
        await page.getByPlaceholder('Select type or search').fill('drive')
        await page.getByRole('option', { name: 'Google Drive', exact: true }).click()
        await page.locator('#field-client_id').fill('e2e-client')
        await page.locator('#field-client_secret').fill('e2e-secret')
        await page.getByRole('button', { name: 'Create Remote' }).click()
        // The stuck login is stopped first, then ours starts: a new server with a new URL.
        await expect
            .poll(async () => {
                const now = await status()
                return now.status === 'running' && now.authUrl !== strayUrl
            })
            .toBe(true)
        expect(await stray).toBe(false)
        // rclone never opens a browser now, on either product: the page offers the link instead.
        // The modal is the one holding a Copy link button; the drawer behind it has none.
        const signIn = page
            .getByRole('dialog')
            .filter({ has: page.getByRole('button', { name: 'Copy link' }) })
        await expect(signIn.getByRole('button', { name: 'Open in browser' })).toBeVisible()
        // Copying leaves the login running and says so, so the link can be finished elsewhere
        // and there is still something to press when it is done.
        await signIn.getByRole('button', { name: 'Copy link' }).click()
        await expect(signIn.getByText(/copied/i)).toBeVisible()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
            (await status()).authUrl
        )
        expect((await status()).status).toBe('running')
        await signIn.getByRole('button', { name: 'Cancel sign-in' }).click()
        await expect.poll(async () => (await status()).status).toBe('stopped')
        await expect.poll(remotes).not.toContain('e2e-oauth')
    } finally {
        await rc('config/oauthstop', {}).catch(() => null)
        await rc('config/delete', { name: 'e2e-stray' }).catch(() => null)
        await rc('config/delete', { name: 'e2e-oauth' }).catch(() => null)
    }
})

// A remote whose token cannot be refreshed: rclone answers every call that touches it with the
// advice to reconnect, which is the only signal the app has. No provider is involved.
const STALE_TOKEN =
    '{"access_token":"expired-x","token_type":"Bearer","expiry":"2020-01-01T00:00:00Z"}'

// The Dashboard's remotes card is behind the getting-started timeline until that is dismissed.
async function dismissOnboarding(page: Page) {
    const doc = await page.request.get('/api/state/app')
    const { version, state } = (await doc.json()) as {
        version: number
        state: Record<string, unknown>
    }
    await page.request.put('/api/state/app', {
        data: { version, state: { ...state, onboarding: { dismissed: true, completed: [] } } },
    })
}

const PROBLEMS = /has a problem|have problems/

test('the Dashboard lists the remotes that do not work, and reconnects only the one rclone names', async ({
    page,
    request,
}) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    try {
        await rc('config/create', {
            name: 'e2e-stale',
            type: 'drive',
            parameters: { client_id: 'probe', client_secret: 'probe', token: STALE_TOKEN },
            opt: { nonInteractive: true },
        })
        // A wrapper fails with its base's advice, and is not the one to sign in again.
        await rc('config/create', {
            name: 'e2e-over-stale',
            type: 'alias',
            parameters: { remote: 'e2e-stale:' },
            opt: { nonInteractive: true },
        })
        await dismissOnboarding(page)

        await page.goto('/')
        const badge = page.getByRole('button', { name: PROBLEMS })
        await expect(badge).toHaveText(/2 have problems/, { timeout: 15_000 })
        await badge.click()

        const drawer = page.getByRole('dialog', { name: 'Remotes with problems' })
        const row = (name: string) => drawer.locator(`li[data-remote="${name}"]`)
        await expect(row('e2e-stale')).toContainText('rclone config reconnect e2e-stale:')
        await expect(row('e2e-stale').getByRole('button', { name: 'Reconnect' })).toBeVisible()
        await expect(row('e2e-over-stale')).toContainText('e2e-stale')
        await expect(drawer.getByRole('button', { name: 'Reconnect' })).toHaveCount(1)
        // The memory remote answers fine, so it is not in the list and not in the count.
        await expect(row('e2e-memory')).toHaveCount(0)
    } finally {
        await rc('config/delete', { name: 'e2e-over-stale' }).catch(() => null)
        await rc('config/delete', { name: 'e2e-stale' }).catch(() => null)
    }
})

test('a remote that cannot be opened or listed says why on its card and in its editor', async ({
    page,
    request,
}) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-health-'))
    try {
        // Cannot be opened: the token is not the JSON rclone writes (a login token pasted in).
        await rc('config/create', {
            name: 'e2e-badtoken',
            type: 'drive',
            parameters: {
                client_id: 'probe',
                client_secret: 'probe',
                token: 'eyJub3QiOiJqc29uIn0',
            },
            opt: { nonInteractive: true },
        })
        // Opens, and cannot be listed: the folder it points at is not there.
        await rc('config/create', {
            name: 'e2e-nolist',
            type: 'alias',
            parameters: { remote: join(dir, 'missing') },
            opt: { nonInteractive: true },
        })

        await page.goto('/remotes')
        const card = (name: string) => page.locator(`[data-remote="${name}"]`)
        await expect(card('e2e-badtoken')).toContainText('invalid character', { timeout: 15_000 })
        await expect(card('e2e-nolist')).toContainText(/Cannot list: .*directory not found/)
        // The reason fits the card it is in (once the card has settled into place), and a remote
        // that works has none.
        await expect
            .poll(async () => (await card('e2e-badtoken').boundingBox())?.height)
            .toBeCloseTo(80, 0)
        await expect(card('e2e-memory').locator('p.text-danger')).toHaveCount(0)

        await card('e2e-nolist').locator('button:has(svg.lucide-settings)').click()
        await page.getByRole('menuitem', { name: 'Edit Config' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('alert')).toContainText('directory not found')
        // Pointed at a folder that is there, it works, and the card says so without a reload.
        await dialog.locator('#field-remote').fill(dir)
        await dialog.getByRole('button', { name: 'Save Changes' }).click()
        await expect(dialog).toHaveCount(0)
        await expect(card('e2e-nolist').locator('p.text-danger')).toHaveCount(0)
        await expect(card('e2e-badtoken')).toContainText('invalid character')
    } finally {
        await rc('config/delete', { name: 'e2e-badtoken' }).catch(() => null)
        await rc('config/delete', { name: 'e2e-nolist' }).catch(() => null)
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a check that could not be asked flags nothing', async ({ page, request }) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    try {
        await rc('config/create', {
            name: 'e2e-stale',
            type: 'drive',
            parameters: { client_id: 'probe', client_secret: 'probe', token: STALE_TOKEN },
            opt: { nonInteractive: true },
        })
        await dismissOnboarding(page)
        // The proxy with no daemon behind it, then a session that lapsed. Both carry an `error`,
        // and neither is rclone speaking about the remote.
        const answers = [
            { status: 503, json: { error: 'the rclone daemon is not running yet', status: 503 } },
            { status: 401, json: { ok: false, error: 'unauthorized' } },
        ]
        for (const answer of answers) {
            let asked = 0
            await page.route('**/api/rc/operations/fsinfo', async (route) => {
                asked += 1
                await route.fulfill(answer)
            })
            await page.goto('/')
            await expect.poll(() => asked).toBeGreaterThanOrEqual(2)
            await expect(page.getByRole('button', { name: PROBLEMS })).toHaveCount(0)
            await page.unroute('**/api/rc/operations/fsinfo')
        }
        // Asked for real, rclone says what is wrong with it.
        await page.goto('/')
        await expect(page.getByRole('button', { name: PROBLEMS })).toHaveText(/1 has a problem/, {
            timeout: 15_000,
        })
    } finally {
        await rc('config/delete', { name: 'e2e-stale' }).catch(() => null)
    }
})

test('a transfer that fails to start on an expired sign-in offers to reconnect', async ({
    page,
    request,
}) => {
    // The server starts transfers now, so the launch's error reaches the page as the answer of
    // a call rather than through the rclone client, which is where the reconnect offer lives.
    // The source is local and passes its check; the destination's token is what has lapsed.
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-stale-start-'))
    writeFileSync(join(dir, 'note.txt'), 'hello')
    try {
        await rc('config/create', {
            name: 'e2e-stale',
            type: 'drive',
            parameters: { client_id: 'probe', client_secret: 'probe', token: STALE_TOKEN },
            opt: { nonInteractive: true },
        })
        await page.goto(
            `/copy?preset=${encodePreset({
                operation: 'copy',
                args: { sources: [`${dir}/`], destination: 'e2e-stale:backup', options: {} },
            })}`
        )
        await page.getByRole('button', { name: 'START COPY' }).click()
        const offer = page.getByRole('dialog', { name: 'Reconnect Remote' })
        await expect(offer).toBeVisible({ timeout: 15_000 })
        // Answered, so the app-wide claim on this remote's dialog is given back.
        await offer.getByRole('contentinfo').getByRole('button', { name: 'Dismiss' }).click()
        await expect(offer).toHaveCount(0)
    } finally {
        await rc('config/delete', { name: 'e2e-stale' }).catch(() => null)
        rmSync(dir, { recursive: true, force: true })
    }
})

test('selecting a remote that needs reconnecting offers it every time', async ({
    page,
    request,
}) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    try {
        await rc('config/create', {
            name: 'e2e-stale',
            type: 'drive',
            parameters: { client_id: 'probe', client_secret: 'probe', token: STALE_TOKEN },
            opt: { nonInteractive: true },
        })
        await page.goto('/commander')
        const places = page.getByRole('navigation', { name: 'Places' })
        const offer = page.getByRole('dialog', { name: 'Reconnect Remote' })

        await places.getByRole('button', { name: 'e2e-stale' }).first().click()
        await expect(offer).toBeVisible()
        // The footer's Dismiss: react-aria puts two hidden dismiss buttons in every modal.
        await offer.getByRole('contentinfo').getByRole('button', { name: 'Dismiss' }).click()
        await expect(offer).toHaveCount(0)

        // A working remote in between behaves as it always did.
        await places.getByRole('button', { name: 'e2e-memory' }).first().click()
        await expect(offer).toHaveCount(0)

        // Asking for it again is the user asking again: the offer comes back rather than the
        // remote failing in silence because the first answer was remembered.
        await places.getByRole('button', { name: 'e2e-stale' }).first().click()
        await expect(offer).toBeVisible()
    } finally {
        await rc('config/oauthstop', {}).catch(() => null)
        await rc('config/delete', { name: 'e2e-stale' }).catch(() => null)
    }
})

test('the create drawer refuses a name another remote already has', async ({ page }) => {
    // rclone's config/create overwrites a section of the same name before it runs any login, so
    // the collision has to be stopped here: by the time it fails there is nothing left to undo.
    await page.goto('/remotes')
    await page.locator('button:has(svg.lucide-plus)').first().click()
    const name = page.getByPlaceholder('Remote name (for your reference)')
    const create = page.getByRole('button', { name: 'Create Remote' })

    const taken = page.getByText('A remote called e2e-memory already exists.')
    await name.fill('e2e-memory')
    await expect(taken).toBeVisible()
    await expect(create).toBeDisabled()

    // The same check the rename field uses, so a name rclone would not accept is refused here
    // too — a leading space among them — and a free name clears both.
    await name.fill(' e2e-memory-2')
    await expect(taken).toHaveCount(0)
    await expect(create).toBeDisabled()
    await name.fill('e2e-memory-2')
    await expect(create).toBeEnabled()

    // One letter is refused on every host, not only where it would be a drive: rclone's rc
    // takes it (only its interactive config refuses), and on Windows `c:` is then the drive
    // and the remote can never be named. A config made here should work wherever it goes.
    await name.fill('c')
    await expect(
        page.getByText(
            'A name needs at least two characters: on Windows a single letter is a drive.'
        )
    ).toBeVisible()
    await expect(create).toBeDisabled()
    await name.fill('cc')
    await expect(create).toBeEnabled()
})

test('an OAuth login is finished from another machine', async ({ page, request }) => {
    const rc = (path: string, data: Record<string, unknown>, timeout?: number) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data, timeout })
    const status = async () =>
        (await (await rc('config/oauthstatus', {})).json()) as { status: string; authUrl?: string }
    const remotes = async () =>
        ((await (await rc('config/listremotes', {})).json()) as { remotes?: string[] }).remotes ??
        []
    try {
        await page.goto('/remotes')
        await page.locator('button:has(svg.lucide-plus)').first().click()
        await page.getByPlaceholder('Remote name (for your reference)').fill('e2e-handoff')
        await page.getByPlaceholder('Select type or search').fill('drive')
        await page.getByRole('option', { name: 'Google Drive', exact: true }).click()
        await page.locator('#field-client_id').fill('e2e-client')
        await page.locator('#field-client_secret').fill('e2e-secret')
        await page.getByRole('button', { name: 'Create Remote' }).click()
        await expect.poll(async () => (await status()).status).toBe('running')

        const signIn = page
            .getByRole('dialog')
            .filter({ has: page.getByRole('button', { name: 'Another machine' }) })
        await signIn.getByRole('button', { name: 'Another machine' }).click()

        // The link handed over is the provider's consent page, not rclone's loopback address:
        // the loopback one resolves to the other machine and reaches nothing.
        const handoff = page
            .getByRole('dialog')
            .filter({ has: page.getByRole('button', { name: 'Finish sign-in' }) })
        const link = handoff.getByLabel('Open this link on the other machine')
        await expect(link).toHaveValue(/^https:\/\/accounts\.google\.com\//)
        await expect(link).toHaveValue(/client_id=e2e-client/)

        // What that machine lands on after approving, pasted back. The code is nonsense, so
        // rclone gets as far as exchanging it and no further — which is what proves it arrived.
        const authUrl = (await status()).authUrl ?? ''
        const state = new URL(authUrl).searchParams.get('state') ?? ''
        expect(state).toBeTruthy()
        const origin = new URL(authUrl).origin
        await handoff
            .getByLabel('Then paste the address it lands on')
            .fill(`${origin}/?code=e2e-bogus-code&state=${state}`)
        await handoff.getByRole('button', { name: 'Finish sign-in' }).click()

        // rclone stops waiting, which is the proof the code arrived: it got as far as trying to
        // exchange it, and only the made-up credentials stopped it there. The section rclone
        // wrote before the login goes with the failure, the same as a cancelled one.
        await expect.poll(async () => (await status()).status).toBe('stopped')
        await expect(handoff).toHaveCount(0)
        await expect.poll(remotes).not.toContain('e2e-handoff')
    } finally {
        await rc('config/oauthstop', {}).catch(() => null)
        await rc('config/delete', { name: 'e2e-handoff' }).catch(() => null)
    }
})

test('a failed metadata lookup downloads the URL in the field', async ({ page }) => {
    // The link lookup answers for the first URL and fails for the second; the download
    // must carry the URL in the field, never the previous one's resolved address.
    const submitted: string[] = []
    await page.route('**/api/rpc/resolve_link', async (route) => {
        const asked = (JSON.parse(route.request().postData() || '{}') as { url: string }).url
        if (asked.startsWith('https://first.example')) {
            await route.fulfill({
                json: {
                    ok: true,
                    value: {
                        url: 'https://cdn.example/first-resolved.mp4',
                        filename: 'First video.mp4',
                        type: 'file',
                    },
                },
            })
        } else {
            await route.abort('failed')
        }
    })
    // A download is a transfer: the page hands it to the server, which submits and records it.
    await page.route('**/api/rpc/transfers_start', async (route) => {
        const sent = JSON.parse(route.request().postData() || '{}') as {
            transfer: {
                operation: string
                sources: string[]
                tags: string[]
                request: { endpoint: string; body: { inputs: { _path: string; url: string }[] } }
            }
        }
        expect(sent.transfer.operation).toBe('download')
        expect(sent.transfer.tags).toEqual(['operation'])
        expect(sent.transfer.request.endpoint).toBe('/job/batch')
        expect(sent.transfer.request.body.inputs[0]._path).toBe('operations/copyurl')
        submitted.push(sent.transfer.request.body.inputs[0].url)
        await route.fulfill({ json: { ok: true, value: { id: 't-99', jobid: 99 } } })
    })
    await page.goto('/download')
    const url = page.getByLabel('URL', { exact: true })
    const filename = page.getByLabel('Filename', { exact: true })
    await url.fill('https://first.example/watch?v=1')
    await expect(filename).toHaveValue('First video.mp4')
    await url.fill('https://second.example/archive.zip')
    await expect(filename).toHaveValue('archive.zip')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:downloads')
    await page.getByRole('button', { name: 'DOWNLOAD' }).click()
    await expect.poll(() => submitted.length).toBe(1)
    expect(submitted[0]).toBe('https://second.example/archive.zip')
})

test('a started download leads to the Transfers page', async ({ page }) => {
    // Nothing is downloaded: the start is answered here, and the URL is no page address.
    await page.route('**/api/rpc/resolve_link', (route) =>
        route.fulfill({ json: { ok: true, value: null } })
    )
    await page.route('**/api/rpc/transfers_start', (route) =>
        route.fulfill({ json: { ok: true, value: { id: 't-98', jobid: 98 } } })
    )
    await page.goto('/download')
    await page.getByLabel('URL', { exact: true }).fill('https://files.example/a.zip')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:downloads')
    await page.getByRole('button', { name: 'DOWNLOAD', exact: true }).click()
    // Started is not finished: the file is not at its destination yet, its transfer is listed.
    await expect(page.getByRole('button', { name: 'NEW DOWNLOAD' })).toBeVisible()
    await page.getByRole('button', { name: 'VIEW TRANSFERS' }).click()
    await expect(page).toHaveURL(/\/transfers$/)
})

test('external content resolution can be switched off, and stays off', async ({ page }) => {
    const asked: string[] = []
    await page.route('**/api/rpc/resolve_link', async (route) => {
        asked.push((JSON.parse(route.request().postData() || '{}') as { url: string }).url)
        await route.fulfill({
            json: {
                ok: true,
                value: {
                    url: 'https://cdn.example/clip.mp4',
                    filename: 'A clip.mp4',
                    type: 'file',
                },
            },
        })
    })
    await page.goto('/download')
    const url = page.getByLabel('URL', { exact: true })
    const filename = page.getByLabel('Filename', { exact: true })
    const off = page.getByRole('checkbox', { name: 'Disable external content resolution' })
    await expect(off).not.toBeChecked()
    // The old line under the field is gone; what it said, and more, is the checkbox's tooltip.
    await expect(page.getByText('Supports Youtube')).toHaveCount(0)
    const label = page.getByText('Disable external content resolution')
    // A tooltip opens for a pointer that travels, not for one that lands.
    const box = (await label.boundingBox()) as {
        x: number
        y: number
        width: number
        height: number
    }
    await expect(async () => {
        await page.mouse.move(0, 0)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
        await expect(page.getByRole('tooltip')).toContainText('Google Drive', { timeout: 2000 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByRole('tooltip')).toContainText('Rednote (Xiaohongshu)')
    await expect(page.getByRole('tooltip')).toContainText('Only links to these websites are sent')
    try {
        await url.fill('https://www.tiktok.com/@a/video/1')
        await expect(filename).toHaveValue('A clip.mp4')
        expect(asked).toEqual(['https://www.tiktok.com/@a/video/1'])
        // Switched off: the name comes from the URL again, and nothing more is asked.
        await off.click()
        await expect(off).toBeChecked()
        await expect(filename).toHaveValue('1')
        // The choice is the server's, not this page's.
        await page.reload()
        await expect(off).toBeChecked()
        await url.fill('https://www.tiktok.com/@a/video/2')
        await expect(filename).toHaveValue('2')
        expect(asked).toHaveLength(1)
    } finally {
        if (await off.isChecked()) await off.click()
        await expect(off).not.toBeChecked()
    }
})

test('a breadcrumb segment opens that folder', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-crumb-'))
    mkdirSync(join(dir, 'inner', 'leaf'), { recursive: true })
    try {
        await page.setViewportSize({ width: 1800, height: 900 })
        await page.goto(`/commander?path=${encodeURIComponent(join(dir, 'inner', 'leaf'))}`)
        await expect(page.getByText('No items').last()).toBeVisible({ timeout: 15_000 })
        // The right panel's bar ends with "inner › leaf"; its "inner" segment is the last one.
        await page.getByRole('button', { name: 'inner', exact: true }).last().click()
        await expect(page.locator(`span[title="${join(dir, 'inner', 'leaf')}"]`)).toBeVisible({
            timeout: 15_000,
        })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('renaming a remote carries its settings along', async ({ page, request }) => {
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    const remotes = async () =>
        ((await (await rc('config/listremotes', {})).json()) as { remotes: string[] }).remotes
    type AppDoc = { version: number; state: Record<string, unknown> }
    const appDoc = async () => (await (await request.get('/api/state/app')).json()) as AppDoc
    await rc('config/create', { name: 'sb-before', type: 'memory', parameters: {} })
    // This server's daemon is the suite's external rcd, on the shared config file.
    const configFile = new URL('./.tmp/rclone.conf', import.meta.url).pathname
    const before = readFileSync(configFile, 'utf8')
    expect(before).toContain('[sb-before]')
    const original = await appDoc()
    // What the app keeps under the remote's name: a mount-on-start setup and a favorite.
    const mountOnStart = {
        enabled: true,
        remotePath: 'sb-before:',
        mountPoint: '/tmp/sb-mount',
        mountOptions: {},
        vfsOptions: {},
        filterOptions: {},
        configOptions: {},
    }
    await request.put('/api/state/app', {
        data: {
            version: original.version,
            state: {
                ...original.state,
                remoteConfigs: {
                    ...((original.state.remoteConfigs as object) ?? {}),
                    'sb-before': { mountOnStart },
                },
                favoritePaths: [{ remote: 'sb-before', path: 'photos', added: 1 }],
            },
        },
    })
    try {
        await page.goto('/remotes')
        const card = page.locator('[data-remote="sb-before"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await card.locator('button:has(svg.lucide-settings)').click()
        await page.getByRole('menuitem', { name: 'Edit Config' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByText('Edit sb-before')).toBeVisible()
        const name = dialog.getByLabel('Name', { exact: true })
        // A clash is caught while typing; the daemon's own memory remote already exists.
        await name.fill('e2e-memory')
        await expect(dialog.getByText('A remote called e2e-memory already exists.')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
        await name.fill('sb-after')
        await dialog.getByRole('button', { name: 'Save Changes' }).click()
        await expect(dialog).toHaveCount(0)
        // Only the section's header line changed in the file, and rclone re-read it.
        await expect
            .poll(() => readFileSync(configFile, 'utf8'))
            .toBe(before.replace('[sb-before]', '[sb-after]'))
        await expect.poll(remotes).toContain('sb-after')
        expect(await remotes()).not.toContain('sb-before')
        await expect(page.locator('[data-remote="sb-after"]')).toBeVisible()
        // The text editor reads the same file through the daemon, external as it is here — and
        // names the path the daemon reported, which is the only place that path comes from.
        await page.getByRole('button', { name: 'Edit config file' }).click()
        await expect(page.getByRole('dialog').getByText(configFile)).toBeVisible()
        // The file is a symlink here. Its text is read through the link, not as the few bytes
        // the link itself is, and the save above went into its target: it is a link still.
        await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(/\[sb-after\]/)
        expect(lstatSync(configFile).isSymbolicLink()).toBe(true)
        await expect(page.getByRole('dialog').locator('textarea[name="content"]')).toHaveValue(
            /\[sb-after\]/
        )
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
        // The settings kept by name moved with it.
        await expect
            .poll(async () => {
                const state = (await appDoc()).state as {
                    remoteConfigs?: Record<string, { mountOnStart?: { mountPoint: string } }>
                    favoritePaths?: { remote: string }[]
                }
                return {
                    mountPoint: state.remoteConfigs?.['sb-after']?.mountOnStart?.mountPoint,
                    old: state.remoteConfigs?.['sb-before'],
                    favorite: state.favoritePaths?.[0]?.remote,
                }
            })
            .toEqual({ mountPoint: '/tmp/sb-mount', old: undefined, favorite: 'sb-after' })
    } finally {
        await rc('config/delete', { name: 'sb-after' })
        await rc('config/delete', { name: 'sb-before' })
        const current = await appDoc()
        await request.put('/api/state/app', {
            data: { version: current.version, state: original.state },
        })
    }
})

test('local folders list through rclone and get their sizes', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-sizes-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'inner.bin'), Buffer.alloc(5))
    writeFileSync(join(dir, 'top.bin'), Buffer.alloc(3))
    try {
        await page.setViewportSize({ width: 1800, height: 900 })
        await page.goto(`/commander?path=${encodeURIComponent(dir)}`)
        // The listing is rclone's: the file comes with its size, the folder's total follows
        // from a size job.
        await expect(page.locator(`span[title="${join(dir, 'top.bin')}"]`)).toBeVisible({
            timeout: 15_000,
        })
        await expect(page.locator(`span[title="${join(dir, 'sub')}"]`)).toBeVisible()
        await expect(page.getByText('3 B', { exact: true }).first()).toBeVisible()
        await expect(page.getByText('5 B', { exact: true }).first()).toBeVisible({
            timeout: 15_000,
        })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

// The Copy page's Metadata section, opened: its region (the first: the mapping panel inside it
// is a region of its own), and the "Show more options" nudge out of the way. The nudge sits
// over the last sections until it is acknowledged; dispatched because the arrow it bobs never
// settles for a real click.
async function openMetadataSection(page: Page) {
    const metadataSection = page.locator('button:has(svg.lucide-tags)')
    await expect(metadataSection).toBeVisible()
    const nudge = page.getByText('Show more options')
    if (await nudge.isVisible()) await nudge.dispatchEvent('click')
    await expect(nudge).toHaveCount(0)
    await metadataSection.click()
    return page.getByRole('region', { name: /Metadata/ }).first()
}

test('the metadata mapper writes a command line, and needs metadata beside it', async ({
    page,
}) => {
    // rclone's `--metadata-mapper` takes a program, not a rule list. The panel at the top of the
    // Metadata section is where that program gets written: the app's own binary and its rules
    // as arguments, into the flag as each rule is completed.
    await page.goto('/copy')
    await page.getByLabel('Source', { exact: true }).fill('/tmp')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:backup')
    const metadata = await openMetadataSection(page)
    const options = metadata.getByRole('textbox', { name: 'Custom Options' })
    const written = () =>
        expect.poll(async () => JSON.parse(await options.inputValue()) as Record<string, unknown>)
    const panel = page.getByRole('region', { name: 'Metadata mapping', exact: true })
    await expect(panel).toHaveCount(0)

    // The chip adds the flag and `metadata` with it, and the panel appears under the title.
    await metadata.getByRole('button', { name: 'metadata_mapper', exact: true }).click()
    await expect(panel).toBeVisible()
    await written().toMatchObject({ metadata: true, metadata_mapper: '' })
    // A field's open suggestion list hides everything else on the page from the accessibility
    // tree, so every entry ends by leaving the field — which is also what commits a typed key
    // that no backend offered.
    // `/tmp` is a local remote, so the source column offers the fields the local backend
    // declares; picking one is what closes its list.
    await panel.getByLabel('From', { exact: true }).fill('mtime')
    await page.getByRole('option', { name: 'mtime' }).click()
    // Half a rule is no rule: the flag is still empty.
    await written().toMatchObject({ metadata_mapper: '' })
    // The memory remote declares none, so this one is typed and no list opens over the page.
    await panel.getByLabel('To', { exact: true }).fill('modified')

    // An argv array pointing at this build's binary — the only form rclone accepts here — beside
    // the `metadata` the chip added, with no Save in between.
    await written().toMatchObject({
        metadata: true,
        metadata_mapper: [
            expect.stringContaining('rclone-cloud'),
            'metadata-map',
            '--map',
            'mtime=modified',
        ],
    })
    await expect(panel).toContainText('metadata-map --map mtime=modified')

    // The flag reads back as the rules that wrote it: a hand edit of the JSON shows up as rules.
    const current = JSON.parse(await options.inputValue()) as { metadata_mapper: string[] }
    const [exe, subcommand] = current.metadata_mapper
    await options.fill(
        JSON.stringify(
            { metadata: true, metadata_mapper: [exe, subcommand, '--drop', 'atime'] },
            null,
            2
        )
    )
    await expect(panel.getByRole('button', { name: 'Drop Rule' })).toBeVisible()
    await expect(panel.getByLabel('Field', { exact: true })).toHaveValue('atime')

    // Taking `metadata` away again leaves a mapper rclone would never run, so the copy cannot
    // start until it is back.
    await metadata.getByRole('button', { name: 'metadata', exact: true }).click()
    await written().not.toHaveProperty('metadata')
    const complaint = /Set "metadata": true to use the metadata mapper/
    await expect(metadata.getByText(complaint)).toBeVisible()
    await expect(page.getByRole('button', { name: complaint })).toBeDisabled()
    // Taking the flag away takes the panel with it.
    await metadata.getByRole('button', { name: 'metadata_mapper', exact: true }).click()
    await expect(panel).toHaveCount(0)
})

test("the mapper offers a backend's own fields, and only writable ones as a destination", async ({
    page,
}) => {
    // Google Drive's metadata as rclone documents it, in place of whatever the e2e remotes carry:
    // a cloud where a file has an owner, and where half the fields can be read but never written.
    const drive = {
        owner: {
            Help: 'The owner of the file. Usually an email address. Enable with --drive-metadata-owner.',
            Type: 'string',
            Example: 'user@example.com',
            ReadOnly: false,
        },
        'created-by-id': {
            Help: 'ID of the user that created the item.',
            Type: 'string',
            ReadOnly: true,
        },
    }
    await page.route('**/operations/fsinfo*', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as Record<string, unknown>
        route.fulfill({ json: { ...body, MetadataInfo: { System: drive, Help: '' } } })
    })

    await page.goto('/copy')
    await page.getByLabel('Source', { exact: true }).fill('/tmp')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:backup')
    const metadata = await openMetadataSection(page)
    await metadata.getByRole('button', { name: 'metadata_mapper', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Metadata mapping', exact: true })
    await expect(panel).toBeVisible()

    // A field that can be written is offered as a destination, with rclone's own help — including
    // the tail that says which flag has to allow it. (Found on the page, not in the panel: an
    // open suggestion list hides every region from role queries, the panel's included.)
    await page.getByLabel('To', { exact: true }).fill('owner')
    await expect(page.getByRole('option', { name: 'owner' })).toContainText(
        'Enable with --drive-metadata-owner'
    )
    // A read-only one is not: writing it would be silently dropped. It is still a source.
    await page.getByLabel('To', { exact: true }).fill('created-by-id')
    await expect(page.getByRole('option', { name: 'created-by-id' })).toHaveCount(0)
    await page.getByLabel('From', { exact: true }).fill('created-by-id')
    await expect(page.getByRole('option', { name: 'created-by-id' })).toBeVisible()
})

test('the mapper says when the destination remote will not write a field', async ({ page }) => {
    // Some backends put their people-shaped fields behind an option of their own. Only the
    // remote's type is faked here: the option names and the defaults that make this fire
    // (`metadata_owner` reads but does not write; `metadata_permissions` is off) are rclone's own,
    // read from `config/providers` at runtime.
    await page.route('**/config/get*', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as Record<string, unknown>
        route.fulfill({ json: { ...body, type: 'drive' } })
    })
    await page.goto('/copy')
    await page.getByLabel('Source', { exact: true }).fill('/tmp')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:backup')
    const metadata = await openMetadataSection(page)
    await metadata.getByRole('button', { name: 'metadata_mapper', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Metadata mapping', exact: true })
    await expect(panel).toBeVisible()

    // On the page, not in the panel: the source's suggestion list opens over `uid` and hides
    // every region from role queries until the panel's heading is clicked.
    await page.getByLabel('From', { exact: true }).fill('uid')
    await page.getByLabel('To', { exact: true }).fill('owner')
    await page.getByText('Metadata mapping').click()
    await expect(panel).toContainText('e2e-memory will not write this field as it is set up now')
    await expect(panel).toContainText('owner needs metadata_owner to include write; it is read.')

    // A field with no such option of its own is never flagged.
    await page.getByLabel('To', { exact: true }).fill('mtime')
    await page.getByText('Metadata mapping').click()
    await expect(panel.getByText(/will not write/)).toHaveCount(0)
})

test('a template keeps the paths a copy was set to, and fills them back in', async ({ page }) => {
    // Runs after "the template drawer keeps its input…", which needs the store to hold no
    // templates yet; this one adds one and leaves it.
    await page.goto('/copy')
    await page.getByLabel('Source', { exact: true }).fill('/tmp')
    await page.getByLabel('Destination', { exact: true }).fill('e2e-memory:paths')
    await page.getByRole('button', { name: 'Templates' }).click()
    await page.getByRole('menuitem', { name: 'SAVE AS TEMPLATE' }).click()
    const namePrompt = page.getByRole('dialog').filter({ hasText: 'Enter a name for the template' })
    await namePrompt.getByRole('textbox').fill('e2e paths')
    await namePrompt.getByRole('button', { name: /^ok$/i }).click()

    // A page that knows nothing: the template is the only place those paths still exist.
    await page.goto('/copy')
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: 'Templates' }).click()
    await page.getByRole('menuitem', { name: 'e2e paths' }).click()
    const applyDialog = page.getByRole('dialog').filter({ hasText: 'Apply Template' })
    // The question now covers both halves of the template.
    await expect(applyDialog).toContainText('flags and paths')
    await applyDialog.getByRole('button', { name: 'Replace All' }).click()

    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('/tmp')
    await expect(page.getByLabel('Destination', { exact: true })).toHaveValue('e2e-memory:paths')

    // A template that carries no paths: Replace All must leave the page's paths where they are
    // rather than emptying them.
    await page.goto('/copy')
    await page.getByRole('button', { name: 'Templates' }).click()
    await page.getByRole('menuitem', { name: 'SAVE AS TEMPLATE' }).click()
    const flagsOnly = page.getByRole('dialog').filter({ hasText: 'Enter a name for the template' })
    await flagsOnly.getByRole('textbox').fill('e2e flags only')
    await flagsOnly.getByRole('button', { name: /^ok$/i }).click()

    await page.getByLabel('Source', { exact: true }).fill('/tmp/keep-me')
    await page.getByRole('button', { name: 'Templates' }).click()
    await page.getByRole('menuitem', { name: 'e2e flags only' }).click()
    const plainDialog = page.getByRole('dialog').filter({ hasText: 'Apply Template' })
    // ... and it asks what it always asked, with nothing about paths in it.
    await expect(plainDialog).not.toContainText('paths')
    await plainDialog.getByRole('button', { name: 'Replace All' }).click()
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('/tmp/keep-me')
})

test('delete takes several paths and removes every one of them', async ({ page, request }) => {
    // Delete's arguments were always a list — one `job/batch` input per path — but its page only
    // ever offered one field, so the rest of a list was dropped on the way in.
    const upload = await request.post(
        '/api/rc/operations/uploadfile?fs=e2e-memory:&remote=multi-delete',
        {
            headers: { 'X-RcloneCloud-Client': 'web' },
            multipart: {
                file0: { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
                file1: { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
            },
        }
    )
    expect(upload.ok()).toBe(true)
    const listing = async () => {
        const response = await request.post('/api/rc/operations/list', {
            headers: SESSION,
            data: { fs: 'e2e-memory:', remote: 'multi-delete' },
        })
        const body = (await response.json()) as { list?: Array<{ Name: string }> }
        return (body.list ?? []).map((item) => item.Name).sort()
    }
    expect(await listing()).toEqual(['one.txt', 'two.txt'])

    const preset = encodePreset({
        operation: 'delete',
        args: {
            sources: ['e2e-memory:multi-delete/one.txt', 'e2e-memory:multi-delete/two.txt'],
        },
    })
    await page.goto(`/delete?preset=${preset}`)
    // Both arrive, and the field says so rather than showing the first alone.
    await expect(page.getByText('and 1 more')).toBeVisible()
    await page.getByRole('button', { name: 'START DELETE' }).click()

    await expect.poll(listing, { timeout: 20_000 }).toEqual([])
})

test('a scheduled run opens where every other transfer does, and can be filtered to its schedule', async ({
    page,
    request,
}) => {
    // A finished run, written into the ledger the way the server writes one.
    const taskId = 'e2e-nightly'
    const runId = '1789606923456-4242'
    const file = join('e2e', '.tmp', 'open', 'transfers', 'ledger.jsonl')
    mkdirSync(join('e2e', '.tmp', 'open', 'transfers'), { recursive: true })
    const id = `${runId}-1`
    appendFileSync(
        file,
        `${[
            {
                event: 'started',
                id,
                ts: '2030-01-01T02:00:00.000Z',
                executeId: 'e2e-run-daemon',
                jobid: 1,
                operation: 'copy',
                sources: ['/tmp/e2e-nightly-src'],
                destination: 'e2e-memory:nightly',
                isDryRun: false,
                taskId,
                taskName: 'Nightly photos',
                runId,
                tags: ['schedule'],
            },
            {
                event: 'finished',
                id,
                ts: '2030-01-01T02:03:00.000Z',
                state: 'completed',
                stats: {
                    bytes: 10,
                    totalBytes: 10,
                    transfers: 1,
                    checks: 0,
                    errors: 0,
                    durationMs: 1,
                },
            },
        ]
            .map((line) => JSON.stringify(line))
            .join('\n')}\n`
    )
    const rpcPost = (name: string, data: Record<string, unknown>) =>
        request.post(`/api/rpc/${name}`, { headers: SESSION, data })
    // By name: the first drawer a store ever closes is followed by a one-time tip about the ESC
    // key, which is a dialog too.
    const drawer = page.getByRole('dialog', { name: /Transfer Details/ })
    const dismissTip = async () => {
        const tip = page.getByRole('dialog', { name: 'Did you know?' })
        await tip
            .waitFor({ timeout: 2000 })
            .then(() => tip.getByRole('button', { name: 'Good to know' }).click())
            .catch(() => {})
        await expect(tip).toBeHidden()
    }
    try {
        await page.goto('/transfers')
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        // Dated 2030, so it is the newest row whatever else the suite has run.
        const row = page.getByRole('tabpanel').getByRole('button').filter({ hasText: 'Schedule' })
        await expect(row.first()).toBeVisible()

        // Its schedule is gone, so there is nothing to open — but the run is still here, with
        // what the record kept, in the drawer every transfer uses.
        await row.first().click()
        await expect(drawer.getByText(/Nightly photos.*no longer exists/)).toBeVisible()
        await expect(page).toHaveURL(/\/transfers/)
        await page.keyboard.press('Escape')
        await expect(drawer).toBeHidden()
        await dismissTip()

        // The schedule, as the page saves one: its form, and the requests a run submits.
        const task = {
            name: 'Nightly photos',
            cron: '0 2 1 1 *',
            operation: 'copy',
            args: {
                sources: ['/tmp/e2e-nightly-src'],
                destination: 'e2e-memory:nightly',
                options: {},
            },
        }
        await rpcPost('scheduler_save', {
            schemaVersion: 1,
            id: taskId,
            enabled: false,
            task,
            spec: {
                name: task.name,
                operation: task.operation,
                cron: task.cron,
                maxRunSeconds: 3600,
                sources: task.args.sources,
                destination: task.args.destination,
                requests: [
                    {
                        endpoint: '/job/batch',
                        body: {
                            inputs: [
                                {
                                    _path: 'sync/copy',
                                    srcFs: '/tmp/e2e-nightly-src',
                                    dstFs: 'e2e-memory:nightly',
                                },
                            ],
                            _async: true,
                        },
                    },
                ],
            },
        })
        await page.reload()
        await page.getByRole('tab', { name: 'INACTIVE' }).click()

        // With the schedule in place the drawer still opens here — no second tab — and offers
        // the way back to it.
        await row.first().click()
        await expect(drawer.getByText(/Started by the schedule .Nightly photos./)).toBeVisible()
        await expect(drawer.getByText(/no longer exists/)).toBeHidden()
        await drawer.getByRole('button', { name: 'Open schedule' }).click()
        await expect(page).toHaveURL(new RegExp(`/schedules/${taskId}$`))
        await expect(page.getByRole('dialog').getByText('Edit Schedule')).toBeVisible()
        await expect(page.getByRole('dialog').getByLabel('Schedule name')).toHaveValue(
            'Nightly photos'
        )

        // And the other way: the schedule's runs, on the Transfers page, only its own.
        await page.goto(`/transfers?task=${taskId}`)
        await expect(page.getByText('Runs of')).toBeVisible()
        await expect(page.getByText('Nightly photos')).toBeVisible()
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        // One row, and it is the scheduled one: the origin badges say what is left.
        const panel = page.getByRole('tabpanel')
        await expect(panel.getByText('Schedule', { exact: true })).toHaveCount(1)
        await expect(panel.getByText('Operation', { exact: true })).toHaveCount(0)
        await expect(panel.getByText('Commander', { exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'Show all' }).click()
        await expect(page).toHaveURL(/\/transfers$/)
        await expect(page.getByText('Runs of')).toBeHidden()
    } finally {
        await rpcPost('scheduler_remove', { taskId })
        // Dated 2030: left in, it would be the newest row of every later test.
        const kept = readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line && (JSON.parse(line) as { id: string }).id !== id)
        writeFileSync(file, kept.map((line) => `${line}\n`).join(''))
    }
})

test('failed files are retried from a list of their own: one, then the rest', async ({
    page,
    request,
}) => {
    // Two unreadable files in a folder copy. The transfer's drawer offers to retry what failed;
    // the list holds only that, and what is ticked in it becomes one new transfer.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-retry-ui-'))
    mkdirSync(join(root, 'src', 'sub'), { recursive: true })
    writeFileSync(join(root, 'src', 'fine.txt'), 'fine')
    writeFileSync(join(root, 'src', 'first.txt'), 'first')
    writeFileSync(join(root, 'src', 'sub', 'second.txt'), 'second')
    const locked = [join(root, 'src', 'first.txt'), join(root, 'src', 'sub', 'second.txt')]
    for (const file of locked) chmodSync(file, 0o000)
    try {
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: {
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
                                },
                            ],
                        },
                    },
                },
            },
        })
        for (const file of locked) chmodSync(file, 0o644)

        await page.goto('/transfers')
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        // Newest first: the failed copy is the top row.
        await page
            .getByRole('tabpanel')
            .locator('button:has(svg.lucide-chevron-right)')
            .first()
            .click()
        const details = page.getByRole('dialog', { name: /Transfer Details/ })
        await expect(details.getByText('FAILED', { exact: true })).toBeVisible()
        await details.getByRole('button', { name: 'Retry failed · 2' }).click()

        // Only what failed, all of it selected: retrying everything is one press.
        const retry = page.getByRole('dialog', { name: 'Retry failed', exact: true })
        await expect(retry.getByRole('option')).toHaveCount(2)
        await expect(retry.getByText('fine.txt')).toHaveCount(0)
        await expect(retry.getByText('2 of 2 selected')).toBeVisible()

        // One file: none, then that one.
        await retry.getByRole('checkbox', { name: 'Select all' }).click()
        await expect(retry.getByRole('button', { name: /^Retry/ })).toBeDisabled()
        await retry.getByRole('option', { name: /first\.txt/ }).click()
        // The rows say what the count says: one tick, on that row. (The list is virtualized and
        // does not re-render its rows when the selection changes, so the tick is the row's own
        // state and not something handed to it.)
        await expect(retry.locator('[role="option"] svg.lucide-check:visible')).toHaveCount(1)
        await expect(
            retry.getByRole('option', { name: /first\.txt/ }).locator('svg.lucide-check')
        ).toBeVisible()
        await retry.getByRole('button', { name: 'Retry 1 selected' }).click()
        await expect(retry).toBeHidden()
        await expect
            .poll(() => existsSync(join(root, 'dst', 'first.txt')), { timeout: 20_000 })
            .toBe(true)
        expect(existsSync(join(root, 'dst', 'sub', 'second.txt'))).toBe(false)
        // The transfer it came from says it was retried, and as what.
        await expect(details.getByText(/Retried as #\d+/)).toBeVisible({ timeout: 10_000 })

        // The rest: everything stays ticked, and rclone skips the file that already arrived.
        await details.getByRole('button', { name: 'Retry failed · 2' }).click()
        await retry.getByRole('button', { name: 'Retry 2 selected' }).click()
        await expect
            .poll(() => existsSync(join(root, 'dst', 'sub', 'second.txt')), { timeout: 20_000 })
            .toBe(true)
        expect(readFileSync(join(root, 'dst', 'sub', 'second.txt'), 'utf8')).toBe('second')
        // The retry ends on its own, and this waits for that: leaving while it runs would have
        // the cleanup after this test stop it mid-flight, and the record then keeps a run with
        // no end for a while, which the Dashboard test after this one would see as live.
        await expect
            .poll(
                async () =>
                    (
                        (await (
                            await request.post('/api/rpc/transfers_list', {
                                headers: SESSION,
                                data: {},
                            })
                        ).json()) as { value: { retryOf?: string; state: string }[] }
                    ).value
                        .filter((entry) => entry.retryOf)
                        .every((entry) => entry.state !== 'running'),
                { timeout: 20_000 }
            )
            .toBe(true)
    } finally {
        for (const file of locked) chmodSync(file, 0o644)
        rmSync(root, { recursive: true, force: true })
    }
})

test('a transfer’s drawer sorts what happened into sections and keeps file errors out of its top', async ({
    page,
    request,
}) => {
    // A folder copy with one unreadable file, and a copy of a file that is not there. The first
    // failure is a file's and is read on that file's row; the second never became a file, so it
    // is the one error with nowhere to go but the top.
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-drawer-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'fine.txt'), 'fine')
    writeFileSync(join(root, 'src', 'locked.txt'), 'locked')
    chmodSync(join(root, 'src', 'locked.txt'), 0o000)
    try {
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: {
                transfer: {
                    operation: 'copy',
                    sources: [`${join(root, 'src')}/`, join(root, 'missing.txt')],
                    destination: join(root, 'dst'),
                    request: {
                        endpoint: '/job/batch',
                        body: {
                            inputs: [
                                {
                                    _path: 'sync/copy',
                                    srcFs: `${join(root, 'src')}/`,
                                    dstFs: join(root, 'dst'),
                                },
                                {
                                    _path: 'operations/copyfile',
                                    srcFs: `${root}/`,
                                    srcRemote: 'missing.txt',
                                    dstFs: join(root, 'dst'),
                                    dstRemote: 'missing.txt',
                                },
                            ],
                        },
                    },
                },
            },
        })
        chmodSync(join(root, 'src', 'locked.txt'), 0o644)
        // The file's error as rclone worded it, which differs by platform.
        const list = await (
            await request.post('/api/rpc/transfers_list', {
                headers: SESSION,
                data: { limit: 50 },
            })
        ).json()
        const id = list.value.find((entry: any) => entry.destination === join(root, 'dst')).id
        const detail = await (
            await request.post('/api/rpc/transfers_detail', {
                headers: SESSION,
                data: { id },
            })
        ).json()
        const fileError: string = detail.value.failed[0].error
        expect(fileError).toContain('locked.txt')

        await page.goto('/transfers')
        await page.getByRole('tab', { name: 'INACTIVE' }).click()
        await page
            .getByRole('tabpanel')
            .locator('button:has(svg.lucide-chevron-right)')
            .first()
            .click()
        const details = page.getByRole('dialog', { name: /Transfer Details/ })
        await expect(details.getByText('FAILED', { exact: true })).toBeVisible()

        // The top: the error that is no file's, by what it was about, and nothing else.
        const top = details.getByRole('alert')
        await expect(top).toHaveCount(1)
        await expect(top).toContainText('missing.txt')
        await expect(top).toContainText('object not found')
        await expect(top).not.toContainText('locked.txt')
        await expect(details).not.toContainText('operations failed')

        // Only the sections that hold something, each file under how it ended.
        const failed = details.getByRole('region', { name: 'Failed' })
        await expect(failed.getByText('locked.txt', { exact: true })).toBeVisible()
        await expect(failed.getByText(fileError)).toBeVisible()
        const transferred = details.getByRole('region', { name: 'Transferred' })
        await expect(transferred.getByText('fine.txt', { exact: true })).toBeVisible()
        await expect(transferred.getByText('locked.txt')).toHaveCount(0)
        await expect(details.getByRole('region', { name: 'Checking' })).toHaveCount(0)
        await expect(details.getByRole('region', { name: 'Transferring' })).toHaveCount(0)

        // A section folds away and comes back.
        const fold = transferred.getByRole('button', { name: /^Transferred/ })
        await expect(fold).toHaveAttribute('aria-expanded', 'true')
        await fold.click()
        await expect(fold).toHaveAttribute('aria-expanded', 'false')
        await expect(transferred.getByText('fine.txt')).toHaveCount(0)
        await expect(failed.getByText('locked.txt', { exact: true })).toBeVisible()
        await fold.click()
        await expect(transferred.getByText('fine.txt', { exact: true })).toBeVisible()

        // The header's buttons say what they do, and the last of them closes the drawer.
        await details.getByRole('button', { name: /^Retry failed/ }).hover()
        await expect(page.getByText('Choose failed files to retry')).toBeVisible()
        await details.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(details).toBeHidden()
        const tip = page.getByRole('dialog', { name: 'Did you know?' })
        await tip
            .waitFor({ timeout: 2000 })
            .then(() => tip.getByRole('button', { name: 'Good to know' }).click())
            .catch(() => {})
    } finally {
        chmodSync(join(root, 'src', 'locked.txt'), 0o644)
        rmSync(root, { recursive: true, force: true })
    }
})

test('the Dashboard’s transfers are the record’s: there after rclone forgets, and from the start', async ({
    page,
    request,
}) => {
    // The panel used to be rclone's memory (its last files, its files in flight): empty after a
    // restart, and blind to a transfer that had not moved a file yet.
    const done = mkdtempSync(join(tmpdir(), 'rcui-e2e-dash-done-'))
    const slow = mkdtempSync(join(tmpdir(), 'rcui-e2e-dash-slow-'))
    writeFileSync(join(done, 'note.txt'), 'hello')
    writeFileSync(join(slow, 'blob.bin'), Buffer.alloc(4 * 1024 * 1024))
    const rc = (path: string, data: Record<string, unknown> = {}) =>
        request.post(`/api/rc/${path}`, { headers: SESSION, data })
    const start = async (dir: string, destination: string) =>
        (
            await (
                await request.post('/api/rpc/transfers_start', {
                    headers: SESSION,
                    data: {
                        transfer: {
                            operation: 'copy',
                            sources: [`${dir}/`],
                            destination,
                            request: {
                                endpoint: '/job/batch',
                                body: {
                                    inputs: [
                                        {
                                            _path: 'sync/copy',
                                            srcFs: `${dir}/`,
                                            dstFs: destination,
                                        },
                                    ],
                                },
                            },
                        },
                    },
                })
            ).json()
        ).value as { id: string }
    let running: { id: string } | undefined
    try {
        // The panel is behind the getting-started timeline until that is dismissed.
        const doc = await page.request.get('/api/state/app')
        const { version, state } = (await doc.json()) as {
            version: number
            state: Record<string, unknown>
        }
        await page.request.put('/api/state/app', {
            data: { version, state: { ...state, onboarding: { dismissed: true, completed: [] } } },
        })

        await start(done, 'e2e-memory:dash-done')
        // rclone forgets, as it does when its daemon restarts.
        await rc('core/stats-reset')
        await page.goto('/')
        await expect(page.getByText('Transfers · recent')).toBeVisible()
        const finished = page.getByRole('listitem').filter({ hasText: done.split('/').pop()! })
        await expect(finished).toBeVisible()
        // The record learns of the end at the next tick: up to five seconds after the launch
        // grace, so more than an assertion's default five.
        await expect(finished).toContainText('Finished', { timeout: 10_000 })

        // One that is running is a row at once, with its progress, under "live".
        await rc('core/bwlimit', { rate: '256k' })
        running = await start(slow, 'e2e-memory:dash-slow')
        await expect(page.getByText('Transfers · live')).toBeVisible({ timeout: 15_000 })
        const moving = page.getByRole('listitem').filter({ hasText: slow.split('/').pop()! })
        await expect(moving.getByRole('progressbar')).toBeVisible()
        await expect(finished).toBeVisible()
    } finally {
        if (running) {
            await request.post('/api/rpc/transfers_stop', {
                headers: SESSION,
                data: { id: running.id },
            })
        }
        await rc('core/bwlimit', { rate: 'off' })
        // The daemon's own speed lingers after a stopped transfer, and the next Dashboard test
        // waits for "Idle".
        await rc('core/stats-reset')
        rmSync(done, { recursive: true, force: true })
        rmSync(slow, { recursive: true, force: true })
    }
})

test('the Dashboard counts transfers, not every file the daemon touches', async ({
    page,
    request,
}) => {
    // Its Moved / Files / Errors were rclone's daemon-wide counters. rclone counts a config file
    // saved through it as a transfer like any other, so editing rclone.conf was "1 file moved".
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-totals-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.txt'), 'aaaa')
    writeFileSync(join(root, 'src', 'b.txt'), 'bb')
    try {
        const doc = await page.request.get('/api/state/app')
        const { version, state } = (await doc.json()) as {
            version: number
            state: Record<string, unknown>
        }
        await page.request.put('/api/state/app', {
            data: { version, state: { ...state, onboarding: { dismissed: true, completed: [] } } },
        })
        await page.goto('/')
        const figure = (label: string) =>
            page
                .locator('dt', { hasText: new RegExp(`^${label}$`) })
                .locator('xpath=following-sibling::dd')
        const files = async () => Number((await figure('Files').innerText()).replace(/\D/g, ''))
        await expect(figure('Files')).toBeVisible()
        await expect(page.getByText('Transfers · last 24 hours')).toBeVisible()
        const before = await files()

        // What saving a config file does: a write through the daemon, which is no transfer.
        const written = await request.post(
            `/api/rc/operations/uploadfile?fs=${encodeURIComponent(root)}&remote=`,
            {
                headers: { 'X-RcloneCloud-Client': 'web' },
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
        // Long enough for every figure on the page to have been read again.
        await page.waitForTimeout(6500)
        expect(await files()).toBe(before)

        // A transfer of two files is two files.
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: {
                transfer: {
                    operation: 'copy',
                    sources: [`${join(root, 'src')}/`],
                    destination: 'e2e-memory:totals',
                    request: {
                        endpoint: '/job/batch',
                        body: {
                            inputs: [
                                {
                                    _path: 'sync/copy',
                                    srcFs: `${join(root, 'src')}/`,
                                    dstFs: `e2e-memory:totals-${Date.now()}`,
                                },
                            ],
                        },
                    },
                },
            },
        })
        await expect.poll(files, { timeout: 15_000 }).toBe(before + 2)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
