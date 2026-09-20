import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import { SERVER_BIN, SESSION, signIn, stopLeftoverJobs } from './helpers'
import type { TransferDetail } from '../src/server/transfers'
import { retryPlan, retryRequest } from '../src/lib/transfers/retry'

// The transfer record: what the server writes about every start, and what survives a restart.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

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
        const list = await rpc('transfers_list', {})
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
                    ((await rpc('transfers_list', {})).value as TransferEntry[]).find(
                        (e) => e.id === started.value.id
                    )?.state,
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
        const failed = ((await rpc('transfers_list', {})).value as TransferEntry[]).find(
            (e) => e.operation === 'sync' && e.sources[0] === join(root, 'missing')
        )
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
            ((await rpc('transfers_list', {})).value as TransferEntry[]).find((e) => e.id === id)
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
        // On disk it is what it says: one JSONL, two lines per transfer.
        const lines = readFileSync(join(data, 'transfers', 'ledger.jsonl'), 'utf8')
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
            ((await rpc('transfers_list', {})).value as TransferEntry[]).find((e) => e.id === id)
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
            ((await rpc('transfers_list', {})).value as TransferEntry[]).find((e) => e.id === id)
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
            (await rpc('transfers_list', {})).value as (TransferEntry & {
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
        const failedEntry = ((await rpc('transfers_list', {})).value as TransferEntry[]).find(
            (entry) => entry.sources[0] === `${join(root, 'src')}/`
        )
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
