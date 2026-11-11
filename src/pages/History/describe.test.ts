import { describe, expect, it } from 'vitest'
import type { Bus, Operations, Transfers } from '../../../lib/core/types'
import { formatDate } from '../../../lib/format'
import type { OperationName } from '../../../lib/operations'
import {
    byDay,
    dayOf,
    durationOf,
    formatDuration,
    formatWhen,
    operationLabel,
    originOf,
    pathsOf,
    standingOf,
    statusOf,
    timingOf,
    transferName,
} from './describe'

const NOW = new Date(2026, 9, 2, 22, 0).getTime()
// The tests run in English (src/testSetup.ts), so the dates are written as English writes them.
const time = (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' })
const at = (daysAgo: number, hours: number, minutes: number) =>
    new Date(2026, 9, 2 - daysAgo, hours, minutes).getTime()

type Transfer = Transfers.Transfer
type TransferProgress = Bus.TransferProgress

/** Builds a transfer. The state and the operation are strings, as the core sends them. */
function transfer(
    over: Omit<Partial<Transfer>, 'state' | 'operation'> & {
        state?: `${Transfers.State}`
        operation?: OperationName
    } = {}
): Transfer {
    return {
        id: 't1',
        seq: 12,
        createdAt: at(0, 21, 0),
        startedAt: at(0, 21, 0),
        endedAt: null,
        sources: ['/Users/me/Photos'],
        destination: 'gdrive:Photos',
        isDryRun: false,
        origin: { kind: 'page' as Transfers.OriginKind },
        error: '',
        stats: null,
        live: null,
        ...over,
        operation: (over.operation ?? 'sync') as Operations.Operation,
        state: (over.state ?? 'running') as Transfers.State,
    }
}

const stats = (over: Partial<NonNullable<Transfer['stats']>> = {}) => ({
    bytes: 0,
    totalBytes: 0,
    transfers: 0,
    checks: 0,
    errors: 0,
    deletes: 0,
    renames: 0,
    durationMs: 0,
    ...over,
})

function live(over: Partial<TransferProgress> = {}): TransferProgress {
    return {
        seq: 12,
        state: 'running',
        bytes: 0,
        totalBytes: 0,
        speed: 0,
        eta: null,
        pct: 0,
        files: 0,
        totalFiles: 0,
        errors: 0,
        checks: 0,
        listed: 0,
        transferring: [],
        checking: [],
        transferred: [],
        ...over,
    }
}

const GB = 1024 * 1024 * 1024

describe('operationLabel', () => {
    it('names the operations', () => {
        expect(operationLabel('sync')).toBe('Sync')
        expect(operationLabel('delete-folder')).toBe('Delete folder')
    })

    it('capitalizes one it does not know', () => {
        expect(operationLabel('mirror')).toBe('Mirror')
    })

    it('names a transfer by its operation and its number', () => {
        expect(transferName(transfer())).toBe('Sync #12')
    })
})

describe('pathsOf', () => {
    it('shows the first source in full, then the destination', () => {
        expect(pathsOf(transfer())).toMatchObject({
            from: '/Users/me/Photos',
            to: 'gdrive:Photos',
            arrow: '→',
            full: '/Users/me/Photos → gdrive:Photos',
        })
    })

    it('counts the other sources, and keeps them all on hover', () => {
        const many = transfer({ sources: ['/a/one', '/b/two', '/c/three'] })
        expect(pathsOf(many)).toMatchObject({
            from: '/a/one + 2 more',
            full: '/a/one, /b/two, /c/three → gdrive:Photos',
        })
    })

    it('goes both ways for a bisync', () => {
        expect(pathsOf(transfer({ operation: 'bisync' }))).toMatchObject({
            arrow: '↔',
            full: '/Users/me/Photos ↔ gdrive:Photos',
        })
    })

    it('names the sources alone without a destination', () => {
        expect(
            pathsOf(transfer({ operation: 'delete', sources: ['gdrive:Old'], destination: '' }))
        ).toMatchObject({ from: 'gdrive:Old', to: '', full: 'gdrive:Old' })
    })
})

describe('originOf', () => {
    const of = (kind: string) => originOf({ kind: kind as Transfers.OriginKind })
    it('names a schedule, a template, a watcher, the Commander or an agent, and not an operation page', () => {
        expect(of('schedule')).toBe('schedule')
        expect(of('template')).toBe('template')
        expect(of('commander')).toBe('commander')
        expect(of('watcher')).toBe('watcher')
        expect(of('agent')).toBe('agent')
        expect(of('page')).toBeNull()
        expect(of('')).toBeNull()
    })
})

describe('standingOf', () => {
    it('labels each end, with how far a stopped transfer got', () => {
        expect(standingOf(transfer({ state: 'completed' }))?.label).toBe('Finished')
        expect(standingOf(transfer({ state: 'failed' }))?.label).toBe('Failed')
        expect(standingOf(transfer({ state: 'interrupted' }))?.label).toBe('Interrupted')
        const stopped = transfer({ state: 'stopped', stats: stats({ bytes: 42, totalBytes: 100 }) })
        expect(standingOf(stopped)?.label).toBe('Stopped at 42%')
        expect(standingOf(transfer())).toBeNull()
        expect(standingOf(transfer({ state: 'queued' }))).toBeNull()
    })
})

describe('formatDuration', () => {
    it('rounds to what matters', () => {
        expect(formatDuration(45_000)).toBe('45 s')
        expect(formatDuration(6 * 60_000 + 10_000)).toBe('6 min')
        expect(formatDuration(72 * 60_000)).toBe('1 h 12 min')
        expect(formatDuration(60 * 60_000)).toBe('1 h')
        expect(formatDuration(51 * 3_600_000)).toBe('2 d 3 h')
    })

    it('carries a rounded-sm minute into the hour', () => {
        expect(formatDuration(3_599_000)).toBe('1 h')
    })
})

describe('formatWhen', () => {
    it('says today and yesterday by the calendar', () => {
        expect(formatWhen(at(0, 9, 5), NOW)).toBe(`Today ${time(at(0, 9, 5))}`)
        expect(formatWhen(at(1, 23, 50), NOW)).toBe(`Yesterday ${time(at(1, 23, 50))}`)
    })

    it('names the weekday within the week, the date before', () => {
        const thisWeek = at(3, 8, 0)
        expect(formatWhen(thisWeek, NOW)).toBe(`Tue ${time(thisWeek)}`)
        const thisYear = new Date(2026, 2, 12, 8, 0).getTime()
        expect(formatWhen(thisYear, NOW)).toBe(`Mar 12, ${time(thisYear)}`)
        const lastYear = new Date(2025, 2, 12, 8, 0).getTime()
        expect(formatWhen(lastYear, NOW)).toBe('Mar 12, 2025')
    })
})

describe('statusOf', () => {
    it('says how far a running transfer is and how long it has left', () => {
        const numbers = live({ bytes: 1.2 * GB, totalBytes: 4 * GB, eta: 180 })
        expect(statusOf(transfer(), numbers)).toBe('1.2 GB of 4 GB · 3 min left')
        expect(statusOf(transfer(), live({ bytes: 1.2 * GB }))).toBe('1.2 GB')
    })

    it('says what a transfer does before it moves anything', () => {
        expect(statusOf(transfer({ state: 'queued' }), undefined)).toBe('Waiting to start')
        expect(statusOf(transfer(), undefined)).toBe('Preparing')
        expect(statusOf(transfer(), live({ listed: 1200 }))).toBe('Preparing · 1,200 listed')
        expect(statusOf(transfer(), live({ checking: [{ name: 'a' }] }))).toBe('Checking 1 file')
    })

    it('says what a finished transfer moved and in how long', () => {
        const done = transfer({
            state: 'completed',
            endedAt: at(0, 21, 6),
            stats: stats({ bytes: 4.2 * GB, transfers: 12, durationMs: 6 * 60_000 }),
        })
        expect(statusOf(done, undefined)).toBe('4.2 GB · 12 files · in 6 min')
        const one = transfer({
            state: 'completed',
            endedAt: at(0, 21, 1),
            stats: stats({ bytes: 512, transfers: 1, durationMs: 45_000 }),
        })
        expect(statusOf(one, undefined)).toBe('512 B · 1 file · in 45 s')
    })

    it('counts what was checked when nothing moved, and says nothing without numbers', () => {
        const checked = transfer({
            state: 'completed',
            endedAt: at(0, 21, 1),
            stats: stats({ checks: 30, durationMs: 4_000 }),
        })
        expect(statusOf(checked, undefined)).toBe('30 checked · in 4 s')
        const bare = transfer({ state: 'completed', endedAt: at(0, 21, 1), stats: stats() })
        expect(statusOf(bare, undefined)).toBe('')
    })

    it("gives the first line of a failed transfer's error", () => {
        const failed = transfer({
            state: 'failed',
            endedAt: at(1, 21, 14),
            error: 'directory not found\nmore detail',
        })
        expect(statusOf(failed, undefined)).toBe('directory not found')
        const silent = transfer({ state: 'failed', endedAt: at(0, 21, 1) })
        expect(statusOf(silent, undefined)).toBe('Open the transfer to see why.')
    })

    it('leaves a stopped transfer to its chip', () => {
        const stopped = transfer({ state: 'stopped', endedAt: at(0, 21, 1) })
        expect(statusOf(stopped, undefined)).toBe('')
    })
})

describe('durationOf', () => {
    it("takes rclone's count, else the record's times", () => {
        expect(
            durationOf(transfer({ endedAt: at(0, 21, 1), stats: stats({ durationMs: 5 }) }))
        ).toBe(5)
        expect(durationOf(transfer({ endedAt: at(0, 21, 1) }))).toBe(60_000)
    })
})

describe('timingOf', () => {
    it('gives how long an ended transfer took', () => {
        const done = transfer({ state: 'completed', endedAt: at(0, 21, 6) })
        expect(timingOf(done, undefined, NOW)).toEqual({ label: 'Duration', value: '6 min' })
    })

    it('gives the time left, or the time run while rclone cannot tell', () => {
        expect(timingOf(transfer(), live({ eta: 90 }), NOW)).toEqual({
            label: 'Time left',
            value: '2 min',
        })
        expect(timingOf(transfer(), live(), NOW)).toEqual({ label: 'Running for', value: '1 h' })
    })

    it('gives nothing for a queued transfer', () => {
        expect(timingOf(transfer({ state: 'queued', startedAt: null }), undefined, NOW)).toBeNull()
    })
})

describe('dayOf', () => {
    it('says today and yesterday, the weekday within the week, then the date', () => {
        expect(dayOf(at(0, 9, 5), NOW)).toBe('Today')
        expect(dayOf(at(1, 23, 50), NOW)).toBe('Yesterday')
        expect(dayOf(at(3, 8, 0), NOW)).toBe('Tuesday')
        expect(dayOf(new Date(2026, 2, 12, 8, 0).getTime(), NOW)).toBe('March 12')
        expect(dayOf(new Date(2025, 2, 12, 8, 0).getTime(), NOW)).toBe('March 12, 2025')
    })
})

describe('byDay', () => {
    it('groups transfers by the day they ended, in their order', () => {
        const rows = [
            { id: 'a', endedAt: at(0, 21, 0), createdAt: 0 },
            { id: 'b', endedAt: at(0, 8, 0), createdAt: 0 },
            { id: 'c', endedAt: at(1, 23, 0), createdAt: 0 },
            { id: 'd', endedAt: null, createdAt: at(1, 7, 0) },
        ]
        expect(byDay(rows, NOW).map((d) => [d.day, d.items.map((r) => r.id)])).toEqual([
            ['Today', ['a', 'b']],
            ['Yesterday', ['c', 'd']],
        ])
    })
})
