import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import {
    OWNER,
    SERVER_BIN,
    SESSION,
    collectErrors,
    runToExit,
    signIn,
    stopLeftoverJobs,
} from './helpers'

// The managed rclone daemon: start, restart, limits, the version floor, --clear, the config file.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

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

test('an rclone older than the server needs stops it before it listens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-old-'))
    // `rclone version` is all the server asks of a binary before it runs it.
    const old = join(root, 'rclone')
    writeFileSync(old, '#!/bin/sh\necho "rclone v1.60.0"\n')
    chmodSync(old, 0o755)
    try {
        const { code, stderr } = await runToExit([
            '--email',
            OWNER.email,
            '--password',
            OWNER.password,
            '--bind',
            '127.0.0.1:5616',
            '--rclone-path',
            old,
            '--data-dir',
            join(root, 'data'),
        ])
        expect(code).toBe(1)
        expect(stderr).toContain(`rclone 1.60.0 (${old}) is older than`)
        expect(stderr).toContain('rclone selfupdate')
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('an external daemon older than the server needs stops it too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-old-daemon-'))
    const daemon = createServer((_, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ version: 'v1.60.0' }))
    })
    await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve))
    const { port } = daemon.address() as { port: number }
    try {
        const { code, stderr } = await runToExit([
            '--email',
            OWNER.email,
            '--password',
            OWNER.password,
            '--bind',
            '127.0.0.1:5616',
            '--rclone-url',
            `http://127.0.0.1:${port}`,
            '--data-dir',
            join(root, 'data'),
        ])
        expect(code).toBe(1)
        expect(stderr).toContain(`rclone 1.60.0 (the daemon at http://127.0.0.1:${port}) is older`)
        expect(stderr).toContain('rclone selfupdate')
    } finally {
        daemon.close()
        rmSync(root, { recursive: true, force: true })
    }
})

test('Settings › Rclone shows the one rclone there is, and nothing about PATH', async ({
    browser,
}) => {
    const base = 'http://127.0.0.1:5612'
    const context = await browser.newContext({ baseURL: base })
    await signIn(context.request, base)
    const binary = (await (
        await context.request.post(`${base}/api/rpc/rclone_binary`, { headers: SESSION, data: {} })
    ).json()) as {
        value: { kind: string; path: string; version: string; installTarget: string | null }
    }
    // Started with --rclone-path, so that is the binary, whatever a page asks for.
    expect(binary.value).toMatchObject({ kind: 'pinned', path: '/usr/local/bin/rclone' })
    expect(binary.value.version).toMatch(/^\d+\.\d+/)
    const refused = (await (
        await context.request.post(`${base}/api/rpc/rclone_set_custom`, {
            headers: SESSION,
            data: { path: '/tmp/some-rclone' },
        })
    ).json()) as { ok: boolean; error?: string }
    expect(refused).toMatchObject({ ok: false, error: 'rclone is pinned by --rclone-path.' })

    const page = await context.newPage()
    const errors = collectErrors(page)
    await page.goto('/settings/rclone')
    await expect(page.getByText(`rclone v${binary.value.version}`)).toBeVisible()
    await expect(page.getByText('/usr/local/bin/rclone').first()).toBeVisible()
    await expect(page.getByText('Pinned by --rclone-path')).toBeVisible()
    // The custom binary input stays, and is the pin's to overrule.
    await expect(
        page.getByPlaceholder('Point to an rclone binary on your machine (/path/to/rclone)')
    ).toBeDisabled()
    await expect(page.getByText('Automatically update rclone')).toBeVisible()
    // One rclone: no PATH switch, and nothing that was downloaded to keep or delete.
    await expect(page.getByText('Add rclone to PATH')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Integration' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
})

test('limits: bandwidth applies at once, the transaction limits through a restart', async ({
    browser,
}) => {
    const base = 'http://127.0.0.1:5612'
    const context = await browser.newContext({ baseURL: base })
    const request = context.request
    await signIn(request, base)
    type Lifecycle = { phase: string; pid?: number }
    const lifecycle = async () =>
        (
            (await (await request.get(`${base}/api/status`)).json()) as {
                lifecycle: Lifecycle | null
            }
        ).lifecycle
    const rc = async (path: string) =>
        (await (
            await request.post(`${base}/api/rc/${path}`, { headers: SESSION, data: {} })
        ).json()) as {
            rate?: string
            main?: { TPSLimit: number; TPSLimitBurst: number }
        }
    const saved = async () =>
        (
            (await (await request.get(`${base}/api/state/app`, { headers: SESSION })).json()) as {
                state: { limits?: { bwLimit: string; tpsLimit: number; tpsLimitBurst: number } }
            }
        ).state.limits
    await expect.poll(async () => (await lifecycle())?.phase, { timeout: 30_000 }).toBe('ready')
    const pid = (await lifecycle())?.pid

    const page = await context.newPage()
    await page.goto('/settings/rclone')
    const bandwidth = page.getByLabel('Bandwidth', { exact: true })
    const tps = page.getByLabel('Transactions per second', { exact: true })
    const burst = page.getByLabel('Transaction burst', { exact: true })
    const save = page.getByRole('button', { name: 'Save limits' })
    await expect(save).toBeDisabled()

    try {
        // rclone is the judge of the syntax, and what it refuses is not kept.
        await bandwidth.fill('nonsense')
        await save.click()
        const refused = page.getByRole('dialog', { name: 'Bandwidth limit not accepted' })
        await expect(refused).toBeVisible()
        await refused.getByRole('button', { name: 'Ok' }).click()
        expect((await saved())?.bwLimit ?? '').toBe('')

        // Bandwidth lands on the running rclone: same process, new rate.
        await bandwidth.fill('1M')
        await save.click()
        await expect.poll(async () => (await rc('core/bwlimit')).rate).toBe('1Mi')
        await expect.poll(async () => (await saved())?.bwLimit).toBe('1M')
        expect((await lifecycle())?.pid).toBe(pid)

        // Busy (a running transfer, stood in for): the choice is to wait or to restart. Waiting
        // keeps nothing.
        await page.route('**/api/rpc/transfers_list', (route) =>
            route.fulfill({
                json: {
                    ok: true,
                    value: [
                        {
                            id: 'e2e-busy',
                            ts: new Date().toISOString(),
                            executeId: 'e2e',
                            jobid: 1,
                            operation: 'copy',
                            sources: ['/tmp/e2e-busy'],
                            destination: 'e2e-memory:busy',
                            isDryRun: false,
                            tags: ['operation'],
                            state: 'running',
                            finishedAt: null,
                            error: null,
                            stats: null,
                        },
                    ],
                },
            })
        )
        await tps.fill('5')
        await burst.fill('2')
        await save.click()
        const busy = page.getByRole('dialog', { name: 'Rclone is busy' })
        await expect(busy.getByText(/interrupts every running transfer/)).toBeVisible()
        await busy.getByRole('button', { name: 'Cancel' }).click()
        await expect(tps).toHaveValue('')
        expect((await saved())?.tpsLimit ?? 0).toBe(0)
        expect((await lifecycle())?.pid).toBe(pid)

        // Restart now: a new process, started with both limits, and the bandwidth with it.
        await tps.fill('5')
        await burst.fill('2')
        await save.click()
        await busy.getByRole('button', { name: 'Restart now' }).click()
        await expect
            .poll(
                async () => {
                    const now = await lifecycle()
                    return now?.phase === 'ready' && now.pid !== pid
                },
                { timeout: 30_000, message: 'rclone did not restart' }
            )
            .toBe(true)
        const main = (await rc('options/get')).main
        expect([main?.TPSLimit, main?.TPSLimitBurst]).toEqual([5, 2])
        expect((await rc('core/bwlimit')).rate).toBe('1Mi')
        expect(await saved()).toEqual({ bwLimit: '1M', tpsLimit: 5, tpsLimitBurst: 2 })
    } finally {
        // The other tests share this daemon: leave it unthrottled.
        await request.patch(`${base}/api/state/app`, {
            headers: {
                ...SESSION,
                'If-Match': String(
                    (
                        (await (
                            await request.get(`${base}/api/state/app`, { headers: SESSION })
                        ).json()) as { revision: number }
                    ).revision
                ),
            },
            data: { set: {}, unset: ['limits'] },
        })
        const before = (await lifecycle())?.pid
        await request.post(`${base}/api/rpc/rclone_restart`, { headers: SESSION, data: {} })
        await expect
            .poll(
                async () => {
                    const now = await lifecycle()
                    return now?.phase === 'ready' && now.pid !== before
                },
                { timeout: 30_000 }
            )
            .toBe(true)
        await context.close()
    }
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

test('--clear empties the data directory and seeds the owner again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-clear-'))
    const data = join(root, 'data')
    // What is there before: an accounts file the server could not even parse (which alone would
    // stop the start without --clear), a stray file and a folder.
    mkdirSync(join(data, 'state'), { recursive: true })
    writeFileSync(join(data, 'state', 'team.json'), 'not json')
    writeFileSync(join(data, 'stray.json'), '{}')
    mkdirSync(join(data, 'stray', 'deep'), { recursive: true })
    writeFileSync(join(data, 'stray', 'deep', 'file.txt'), 'x')

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
        expect(existsSync(join(data, 'stray.json'))).toBe(false)
        expect(existsSync(join(data, 'stray'))).toBe(false)
        // The emptied directory was then brought to the current layout.
        expect(JSON.parse(readFileSync(join(data, 'storage.json'), 'utf8'))).toEqual({ version: 1 })
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

test('on the managed daemon a rename edits the config file in place', async ({ browser }) => {
    const base = 'http://127.0.0.1:5612'
    const context = await browser.newContext({ baseURL: base })
    const request = context.request
    await signIn(request, base)
    const rc = (path: string, data: Record<string, unknown>) =>
        request.post(`${base}/api/rc/${path}`, { headers: SESSION, data })
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
