import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { SESSION, signIn, stopLeftoverJobs } from './helpers'
import type { TransferDetail, TransferEntry } from '../src/server/transfers'

// Schedules: a scheduled run is a transfer on the daemon the server already runs.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

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
        // Slow enough for the run to look at its files while they go by. On the daemon, not in
        // the job file: a run submits transfers, and a bandwidth limit is not one.
        await api.post(`${base}/api/rc/core/bwlimit`, { headers: SESSION, data: { rate: '64k' } })
        const registered = await rpc('scheduler_register', {
            enabled: false,
            spec: {
                schemaVersion: 1,
                taskId,
                name: 'E2E collect',
                operation: 'copy',
                cron: '0 3 1 1 *',
                sources: [`${join(root, 'src')}/`],
                destination: destination,
                requests: [
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
            ((await rpc('transfers_list', {})).value as TransferEntry[]).find(
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
        await api.post(`${base}/api/rc/core/bwlimit`, { headers: SESSION, data: { rate: 'off' } })
        await rpc('scheduler_unregister', { taskId })
        await context.close()
        rmSync(root, { recursive: true, force: true })
    }
})
