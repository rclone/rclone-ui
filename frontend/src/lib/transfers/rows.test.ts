import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { TransferEntry } from '@/server/transfers'
import { ENDED, type LiveStats, isScheduled, toRows, totalsOf } from './rows'

// lib/transfers/rows.ts is pure: the record the server keeps, overlaid with rclone's live numbers
// for whatever is still running. The list exists without rclone; only the numbers need it.

// As the server sends one: what a transfer does not have is absent, not null.
const entry = (patch: Partial<TransferEntry>): TransferEntry => ({
    id: 't1',
    ts: '2026-01-01T00:00:00.000Z',
    executeId: 'daemon-1',
    jobid: 4,
    operation: 'copy',
    sources: ['/tmp/a'],
    destination: 'remote:b',
    isDryRun: false,
    tags: [],
    state: 'running',
    finishedAt: null,
    error: null,
    stats: null,
    ...patch,
})

const live = (patch: Partial<LiveStats>): LiveStats => ({
    bytes: 0,
    totalBytes: 0,
    speed: 0,
    listed: 0,
    transferring: 0,
    checking: 0,
    transfers: 0,
    errors: 0,
    ...patch,
})

test('a transfer that just started is a row before rclone has anything to say about it', () => {
    // The gap this replaced: rclone lists both ends before a file moves, and a list built from
    // its files in flight had nothing to show for seconds.
    const { active, inactive } = toRows([entry({})], {})
    expect(inactive).toEqual([])
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
        id: 't1',
        jobid: 4,
        type: 'active',
        phase: 'preparing',
        progress: 0,
        speed: 0,
        sources: ['/tmp/a'],
    })
    // Listing is still "preparing", with a count to show for it.
    expect(toRows([entry({})], { t1: live({ listed: 82 }) }).active[0]).toMatchObject({
        phase: 'preparing',
        listed: 82,
    })
})

test('live numbers belong to running rows only', () => {
    const rows = toRows(
        [
            entry({ id: 'moving' }),
            entry({ id: 'checking' }),
            entry({
                id: 'done',
                state: 'completed',
                finishedAt: '2026-01-01T00:01:00.000Z',
                stats: {
                    bytes: 10,
                    totalBytes: 10,
                    transfers: 2,
                    checks: 0,
                    errors: 0,
                    durationMs: 9,
                },
            }),
        ],
        {
            moving: live({ bytes: 50, totalBytes: 200, speed: 7, transferring: 1 }),
            checking: live({ checking: 3 }),
            // A finished transfer's group may still answer; the record is what counts.
            done: live({ bytes: 1, totalBytes: 99, speed: 5 }),
        }
    )
    expect(rows.active.map((row) => [row.id, row.phase, row.progress, row.speed])).toEqual([
        ['moving', 'transferring', 25, 7],
        ['checking', 'checking', 0, 0],
    ])
    expect(rows.active[1].checkingCount).toBe(3)
    expect(rows.inactive[0]).toMatchObject({
        id: 'done',
        type: 'inactive',
        phase: null,
        bytes: 10,
        totalBytes: 10,
        progress: 100,
        speed: 0,
    })
})

test('how a transfer ended is the record’s to say', () => {
    const rows = toRows(
        [
            entry({ id: 'failed', state: 'failed', error: 'directory not found' }),
            entry({
                id: 'stopped',
                state: 'stopped',
                stats: {
                    bytes: 5,
                    totalBytes: 20,
                    transfers: 1,
                    checks: 0,
                    errors: 0,
                    durationMs: 1,
                },
            }),
            entry({ id: 'interrupted', state: 'interrupted' }),
            entry({ id: 'unknown', state: 'unknown', error: 'It ended while…' }),
            entry({ id: 'dry', state: 'completed', isDryRun: true }),
        ],
        {}
    ).inactive
    // Only a failure is one: a stop, an interruption and an unknown end each say so themselves.
    expect(rows.map((row) => [row.id, row.state])).toEqual([
        ['failed', 'failed'],
        ['stopped', 'stopped'],
        ['interrupted', 'interrupted'],
        ['unknown', 'unknown'],
        ['dry', 'completed'],
    ])
    expect(rows[1].progress).toBe(25)
    expect(rows[4].isDryRun).toBe(true)
    // A completed transfer that moved nothing (everything was already there) is still complete.
    expect(toRows([entry({ state: 'completed', stats: null })], {}).inactive[0].progress).toBe(100)
})

test('a row is its entry, with where it stands beside it', () => {
    // One shape: what the record says of a transfer reads straight off its row, so a field added
    // to a transfer needs no copying here.
    const recorded = entry({ id: 'kept', preset: { operation: 'copy' }, retryOf: 'earlier' })
    const [row] = toRows([recorded], {}).active
    expect(row).toMatchObject(recorded)
    expect(row.preset).toEqual({ operation: 'copy' })
    expect(row.retryOf).toBe('earlier')
    // How an ended transfer says so is written once, for the list, the drawer and the Dashboard.
    expect(ENDED.completed.label).toBe('Finished')
    expect(ENDED.failed).toEqual({ label: 'Failed', color: 'danger' })
    expect(Object.keys(ENDED).sort()).toEqual(
        ['completed', 'failed', 'interrupted', 'stopped', 'unknown'].sort()
    )
})

test('the Dashboard’s totals are the record’s, over a window, and count what is still running', () => {
    // They used to be rclone's daemon-wide counters, which count every file the daemon touches:
    // saving rclone.conf was "1 file moved". The record holds transfers and nothing else.
    const now = Date.parse('2026-01-02T12:00:00.000Z')
    const done = (id: string, finishedAt: string, bytes: number, transfers: number, errors = 0) =>
        entry({
            id,
            state: errors > 0 ? 'failed' : 'completed',
            finishedAt,
            stats: { bytes, totalBytes: bytes, transfers, checks: 0, errors, durationMs: 1 },
        })
    const { active, inactive } = toRows(
        [
            entry({ id: 'going', ts: '2026-01-02T11:59:00.000Z' }),
            done('today', '2026-01-02T09:00:00.000Z', 1000, 4),
            done('with-errors', '2026-01-01T13:00:00.000Z', 50, 1, 2),
            done('too-old', '2026-01-01T11:00:00.000Z', 9_000_000, 900, 9),
            { ...done('dry', '2026-01-02T10:00:00.000Z', 7_000_000, 70), isDryRun: true },
        ],
        { going: live({ bytes: 300, totalBytes: 900, transfers: 2, errors: 1 }) }
    )
    expect(active[0]).toMatchObject({ fileCount: 2, errorCount: 1, bytes: 300 })
    expect(inactive[0]).toMatchObject({ fileCount: 4, errorCount: 0 })

    const day = 24 * 60 * 60 * 1000
    expect(totalsOf([...active, ...inactive], now - day, now)).toEqual({
        bytes: 1350,
        files: 7,
        errors: 3,
    })
    // Nothing recorded, nothing moved: whatever else the daemon did is not a transfer.
    expect(totalsOf([], now - day, now)).toEqual({ bytes: 0, files: 0, errors: 0 })
})

test('a scheduled run is one by its tag, and says which schedule and which run it was', () => {
    const run = entry({
        tags: ['schedule'],
        taskId: 'nightly',
        taskName: 'Nightly photos',
        runId: '1789-42',
    })
    const [row] = toRows([run], {}).active
    expect(row.scheduled).toEqual({ taskId: 'nightly', runId: '1789-42', name: 'Nightly photos' })
    expect(isScheduled(run)).toBe(true)
    // The ids say which schedule and which run. They do not say that it is one.
    const untagged = entry({ taskId: 'nightly', runId: '1789-42' })
    expect(isScheduled(untagged)).toBe(false)
    expect(toRows([untagged], {}).active[0].scheduled).toBeNull()
    expect(toRows([entry({})], {}).active[0].scheduled).toBeNull()
})

test('where a transfer came from is on its row, for the badge', () => {
    expect(toRows([entry({ tags: ['commander'] })], {}).active[0].tags).toEqual(['commander'])
    expect(toRows([entry({ tags: ['operation'] })], {}).active[0].tags).toEqual(['operation'])
    // One recorded before there were tags has none, and gets no badge.
    expect(toRows([entry({})], {}).active[0].tags).toEqual([])
})

// What exists and how it ended is the record's to say. rclone is asked for the live numbers of a
// job that is running, in one file, and nowhere is a list of transfers made from what it answers.
// (Every start the app makes is recorded; the Download page's URL download included.)
test('nothing but the live reads asks rclone about jobs', () => {
    const root = new URL('../../..', import.meta.url).pathname
    const sources = ['src'].flatMap((dir) =>
        (readdirSync(join(root, dir), { recursive: true }) as string[])
            .filter((file) => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file))
            .map((file) => join(dir, file))
    )
    const mentions = (pattern: RegExp) =>
        sources.filter((file) => pattern.test(readFileSync(join(root, file), 'utf8'))).sort()

    // An endpoint is a quoted string; a comment that names one is not a call.
    const endpoint = (names: string) => new RegExp(`['"]/?(${names})['"]`)

    // Size jobs are not transfers: a folder's size is computed as a job of its own.
    expect(mentions(endpoint('core/transferred|job/list|core/group-list|job/status'))).toEqual([
        'src/lib/rclone/daemon-fs.ts',
        'src/lib/transfers/live.ts',
    ])
    // The Dashboard reads the daemon's own throughput and totals, which are no transfer's.
    expect(mentions(endpoint('core/stats'))).toEqual([
        'src/lib/transfers/live.ts',
        'src/pages/Dashboard/index.tsx',
    ])
})
