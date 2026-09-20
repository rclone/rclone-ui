import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, type Request, expect, test } from '@playwright/test'
import { presetRoute } from '../src/lib/rclone/preset'
import { stopLeftoverJobs } from './helpers'

// The Commander's listings are cached (`components/navigator/listing.ts`): a folder is asked of
// rclone once and shown from memory for a while; only a refresh, a change made here, or a
// transfer that ended asks again. These count `operations/list` per directory to say so.

const SESSION = { 'X-RcloneCloud-Client': 'web', 'Content-Type': 'application/json' }

// Every local listing starts folder-size jobs on the shared daemon; they stop with the test.
test.afterEach(({ request }) => stopLeftoverJobs(request))

/** A request's `fs` and `remote`, from its query or its body, however the client sent them. */
function paramsOf(sent: Request): Record<string, string> {
    const params: Record<string, string> = {}
    for (const [key, value] of new URL(sent.url()).searchParams) params[key] = value
    try {
        const body = sent.postDataJSON() as Record<string, unknown> | null
        for (const [key, value] of Object.entries(body ?? {})) {
            if (typeof value === 'string') params[key] = value
        }
    } catch {}
    return params
}

/** `operations/list` requests per directory; the trailing-slash retry counts with its folder. */
function countListings(page: Page) {
    const counts = new Map<string, number>()
    page.on('request', (sent) => {
        if (!new URL(sent.url()).pathname.endsWith('/operations/list')) return
        const { fs = '', remote = '' } = paramsOf(sent)
        const key = `${fs}${remote.replace(/\/$/, '')}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    const of = (dir: string) =>
        counts.get(`:local:/${dir.replace(/^\/+/, '').replace(/\/+$/, '')}`) ?? 0
    const total = () => [...counts.values()].reduce((a, b) => a + b, 0)
    return { of, total }
}

/** A folder with a file and a subfolder holding another, for the right panel to show. */
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'rcui-e2e-cache-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'inner')
    writeFileSync(join(dir, 'top.txt'), 'top')
    return dir
}

const title = (page: Page, fullPath: string) => page.locator(`span[title="${fullPath}"]`)
const rowOf = (page: Page, fullPath: string) =>
    page.locator('[draggable]').filter({ has: page.locator(`span[title="${fullPath}"]`) })

async function openCommander(page: Page, dir: string) {
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/commander?path=${encodeURIComponent(dir)}`)
    await expect(title(page, join(dir, 'top.txt'))).toBeVisible({ timeout: 15_000 })
}

test('into a folder and back: each directory is listed once', async ({ page }) => {
    const dir = fixture()
    const listings = countListings(page)
    try {
        await openCommander(page, dir)
        await title(page, join(dir, 'sub')).click()
        await expect(title(page, join(dir, 'sub', 'inner.txt'))).toBeVisible()
        await page.getByRole('button', { name: 'BACK' }).last().click()
        await expect(title(page, join(dir, 'top.txt'))).toBeVisible()
        await title(page, join(dir, 'sub')).click()
        await expect(title(page, join(dir, 'sub', 'inner.txt'))).toBeVisible()
        expect(listings.of(dir)).toBe(1)
        expect(listings.of(join(dir, 'sub'))).toBe(1)
        // Rows live in memory only: a folder of a million files must not be written to disk.
        const stored = await page.evaluate(
            () => localStorage.getItem('rclone-cloud-persisted-query-cache') ?? ''
        )
        expect(stored).not.toContain('listing')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('starring a row and toggling a shortcut list nothing', async ({ page, request }) => {
    // Both write the app document, and every page rehydrates its store on the announcement;
    // the listing effect used to depend on the favourites array and re-list both panels.
    const dir = fixture()
    const listings = countListings(page)
    const doc = async () =>
        (await (await request.get('/api/state/app', { headers: SESSION })).json()) as {
            revision: number
            state: Record<string, unknown>
        }
    const count = async (key: string) => (((await doc()).state[key] as unknown[]) ?? []).length
    try {
        await openCommander(page, dir)
        // The two folders on screen: the fixture on the right, home on the left.
        const shown = () => [listings.of(dir), listings.of(homedir())]
        const settled = shown()
        const sub = rowOf(page, join(dir, 'sub'))
        await sub.hover()
        await sub.locator('button:has(svg.lucide-star)').click()
        await expect.poll(() => count('favoritePaths')).toBe(1)
        // The cog hides a disk (the document again; the API puts it back at the end). Closed
        // by a click outside: with a favourite on the sidebar, Escape after a toggle leaves
        // this popover open, a quirk of the popover and not of the cache.
        await page.getByRole('button', { name: 'Shortcuts' }).click()
        const panel = page.getByRole('dialog', { name: 'Shortcuts' })
        const first = panel.getByRole('switch').first()
        await first.dispatchEvent('click')
        await expect(first).not.toBeChecked()
        await page.mouse.click(10, 10)
        await expect(panel).toHaveCount(0)
        await expect.poll(() => count('hiddenLocalPaths')).toBe(1)
        // Unstarred from the row. A row's flags travel on the row (`VirtualizedEntry`): read
        // from a prop instead, the star would answer with the state of its first render and
        // put the favourite straight back.
        await sub.hover()
        await sub.locator('button:has(svg.lucide-star)').click()
        await expect.poll(() => count('favoritePaths')).toBe(0)
        // A bounded wait: a re-listing would have been sent by now.
        await page.waitForTimeout(750)
        expect(shown()).toEqual(settled)
    } finally {
        rmSync(dir, { recursive: true, force: true })
        const after = await doc()
        await request.patch('/api/state/app', {
            headers: { ...SESSION, 'If-Match': String(after.revision) },
            data: { set: { favoritePaths: [], hiddenLocalPaths: [] }, unset: [] },
        })
    }
})

test('leaving the Commander and coming back lists nothing', async ({ page }) => {
    // In-app both ways: a reload would empty the memory the cache lives in.
    const dir = fixture()
    const listings = countListings(page)
    try {
        await openCommander(page, dir)
        // The two folders the panels show; the Dashboard's own remote health probe lists too.
        const shown = () => [listings.of(dir), listings.of(homedir())]
        const settled = shown()
        const nav = page.getByRole('navigation', { name: 'Sidebar' })
        await nav.getByRole('link', { name: 'Dashboard' }).click()
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
        await page.goBack()
        await expect(title(page, join(dir, 'top.txt'))).toBeVisible({ timeout: 15_000 })
        await page.waitForTimeout(500)
        expect(shown()).toEqual(settled)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the refresh button asks for that folder again, and only that one', async ({ page }) => {
    const dir = fixture()
    const listings = countListings(page)
    try {
        await openCommander(page, dir)
        const others = () => listings.total() - listings.of(dir)
        const before = others()
        await page.locator('button:has(svg.lucide-refresh-cw)').last().click()
        await expect.poll(() => listings.of(dir)).toBe(2)
        await page.waitForTimeout(500)
        expect(others()).toBe(before)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a change in one panel leaves the other panel's listing alone", async ({ page }) => {
    const dir = fixture()
    const listings = countListings(page)
    try {
        await openCommander(page, dir)
        const others = () => listings.total() - listings.of(dir)
        const before = others()

        await page.getByRole('button', { name: 'NEW' }).last().click()
        const namePrompt = page.getByRole('dialog').filter({ hasText: 'Enter a name' })
        await namePrompt.getByRole('textbox').fill('made')
        await namePrompt.getByRole('button', { name: /^ok$/i }).click()
        await expect(title(page, join(dir, 'made'))).toBeVisible()
        await expect.poll(() => listings.of(dir)).toBe(2)

        await rowOf(page, join(dir, 'made')).locator('button:has(svg.lucide-pencil)').click()
        const renamePrompt = page.getByRole('dialog').filter({ hasText: 'Enter a new name' })
        await renamePrompt.getByRole('textbox').fill('renamed')
        await renamePrompt.getByRole('button', { name: /^ok$/i }).click()
        await expect(title(page, join(dir, 'renamed'))).toBeVisible()
        await expect.poll(() => listings.of(dir)).toBe(3)

        await rowOf(page, join(dir, 'renamed')).locator('button:has(svg.lucide-trash-2)').click()
        await page
            .getByRole('dialog')
            .filter({ hasText: 'Confirm Delete' })
            .getByRole('button', { name: 'Yes' })
            .click()
        await expect(title(page, join(dir, 'renamed'))).toHaveCount(0)
        await expect.poll(() => listings.of(dir)).toBe(4)

        await page.waitForTimeout(500)
        expect(others()).toBe(before)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the picker opened twice on the same folder lists it once', async ({ page }) => {
    const dir = fixture()
    const listings = countListings(page)
    try {
        await page.goto(presetRoute({ operation: 'copy', args: { sources: [dir] } }))
        const open = page.locator('button:has(svg.lucide-folder-open)').first()
        const picker = page.getByRole('dialog').filter({ hasText: /0 SELECTED|PICK/ })
        const kept = picker.locator('[draggable]', { hasText: 'top.txt' })
        await open.click()
        await expect(kept).toBeVisible()
        await picker.locator('button:has(svg.lucide-x)').first().click()
        await expect(picker).toHaveCount(0)
        await open.click()
        await expect(kept).toBeVisible()
        expect(listings.of(dir)).toBe(1)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a copy started elsewhere shows up in the folder it landed in, with no refresh', async ({
    page,
    request,
}) => {
    // The record hears of the end at the server's next look at the job; the page hears of the
    // record's line and asks for the destination again.
    const dir = fixture()
    const src = mkdtempSync(join(tmpdir(), 'rcui-e2e-cache-src-'))
    writeFileSync(join(src, 'landed.txt'), 'landed')
    try {
        await openCommander(page, dir)
        const started = await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: {
                transfer: {
                    operation: 'copy',
                    sources: [`${src}/`],
                    destination: dir,
                    request: {
                        endpoint: '/job/batch',
                        body: { inputs: [{ _path: 'sync/copy', srcFs: `${src}/`, dstFs: dir }] },
                    },
                },
            },
        })
        expect(started.ok()).toBe(true)
        await expect(title(page, join(dir, 'landed.txt'))).toBeVisible({ timeout: 20_000 })
    } finally {
        rmSync(dir, { recursive: true, force: true })
        rmSync(src, { recursive: true, force: true })
    }
})

test('the right panel starts on the first remote, cold or warm', async ({ page }) => {
    // Cold: no persisted query cache, so the remotes list arrives after the first render. The
    // panel used to lock onto local home before it did.
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('rclone-cloud-persisted-query-cache'))
    await page.goto('/commander')
    const root = page.getByRole('button', { name: 'memory e2e-memory' })
    await expect(root).toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(root).toBeVisible({ timeout: 15_000 })
})
