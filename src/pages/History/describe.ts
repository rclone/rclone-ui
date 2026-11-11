// Builds the text that History shows for a transfer: the paths and the status of each row, such
// as "Photos → gdrive:Photos" and "1.2 GB of 4 GB · 3 min left", and the summary of the details.

import { plural, t } from '@lingui/core/macro'
import type { Bus, Transfers } from '../../../lib/core/types'
import { buildReadablePath, formatBytes, formatDate, formatNumber } from '../../../lib/format'
import { ENDED, percent, phaseOf } from '../../../lib/transfers/rows'
import { WINDOWS } from '../../routes'

type Transfer = Transfers.Transfer
type TransferProgress = Bus.TransferProgress

/**
 * Operation names, as the window title and the launcher show them. The Commander's small
 * operations have no window, so they have names of their own.
 */
const OPERATIONS: Record<string, string> = {
    copy: WINDOWS.copy.title,
    move: WINDOWS.move.title,
    sync: WINDOWS.sync.title,
    bisync: WINDOWS.bisync.title,
    delete: WINDOWS.delete.title,
    purge: WINDOWS.purge.title,
    download: WINDOWS.download.title,
    cleanup: t({
        message: 'Cleanup',
        comment: "The name of an operation in History: emptying a remote's trash.",
    }),
    save: t({
        message: 'Save',
        comment: 'The name of an operation in History: a file saved from the Commander.',
    }),
    rename: t({
        message: 'Rename',
        comment: 'The name of an operation in History: a rename in the Commander.',
    }),
    'delete-folder': t({
        message: 'Delete folder',
        comment: "The name of an operation in History: a folder's deletion in the Commander.",
    }),
}

const DAY = 86_400_000

export function operationLabel(operation: string): string {
    return OPERATIONS[operation] ?? operation.charAt(0).toUpperCase() + operation.slice(1)
}

export function transferName(transfer: Pick<Transfer, 'operation' | 'seq'>): string {
    const operation = operationLabel(transfer.operation)
    const seq = transfer.seq
    return t({
        message: `${operation} #${seq}`,
        comment: 'A transfer, by its operation and its number: "Sync #12".',
    })
}

/**
 * The paths of a row: the first source in full, with "+ N more" for the others, and the
 * destination. A bisync goes both ways (↔). `full` holds the raw paths, shown on hover.
 */
export function pathsOf(transfer: Pick<Transfer, 'operation' | 'sources' | 'destination'>) {
    const [head, ...rest] = transfer.sources
    const first = head ? buildReadablePath(head) : ''
    const arrow = transfer.operation === 'bisync' ? '↔' : '→'
    const others = rest.length
    return {
        from:
            others > 0
                ? t({
                      message: plural(others, {
                          one: `${first} + # more`,
                          other: `${first} + # more`,
                      }),
                      comment:
                          'The first source of a transfer, and how many others it has: "Photos + 2 more".',
                  })
                : first,
        to: transfer.destination ? buildReadablePath(transfer.destination) : '',
        arrow,
        full: [transfer.sources.join(', '), transfer.destination]
            .filter(Boolean)
            .join(` ${arrow} `),
    }
}

/**
 * Formats a duration in at most two units, with their short names: "45 s", "6 min",
 * "1 h 12 min", "2 d 3 h".
 */
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) {
        return t({ message: `${seconds} s`, comment: 'A length of time: "45 s" is 45 seconds.' })
    }
    const inMinutes = Math.round(seconds / 60)
    if (inMinutes < 60) {
        const minutes = inMinutes
        return t({ message: `${minutes} min`, comment: 'A length of time: "6 min" is 6 minutes.' })
    }
    const hours = Math.floor(inMinutes / 60)
    if (hours < 24) {
        const minutes = inMinutes % 60
        if (minutes === 0) {
            return t({ message: `${hours} h`, comment: 'A length of time: "2 h" is 2 hours.' })
        }
        return t({
            message: `${hours} h ${minutes} min`,
            comment: 'A length of time: "1 h 12 min" is 1 hour and 12 minutes.',
        })
    }
    const days = Math.floor(hours / 24)
    const hoursLeft = hours % 24
    if (hoursLeft === 0) {
        return t({ message: `${days} d`, comment: 'A length of time: "2 d" is 2 days.' })
    }
    return t({
        message: `${days} d ${hoursLeft} h`,
        comment: 'A length of time: "2 d 3 h" is 2 days and 3 hours.',
    })
}

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)

/** The time of day of `ms`, such as "21:14", in the app's language. */
export function clockOf(ms: number): string {
    return formatDate(ms, { hour: '2-digit', minute: '2-digit' })
}

/**
 * Formats a time with only as much detail as needed: "Today 21:14", "Yesterday 21:14",
 * "Mon 21:14" within the past week, "12 Mar 21:14" within this year, and "12 Mar 2024" for
 * anything older. The app's language orders the parts.
 */
export function formatWhen(ms: number, now = Date.now()): string {
    const at = new Date(ms)
    const time = clockOf(ms)
    // Count calendar days rather than 24-hour spans, so a transfer that ended at 23:50 is shown
    // as "Yesterday" ten minutes later.
    const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
    if (days === 0) {
        return t({ message: `Today ${time}`, comment: 'A time today: "Today 21:14".' })
    }
    if (days === 1) {
        return t({ message: `Yesterday ${time}`, comment: 'A time yesterday: "Yesterday 21:14".' })
    }
    if (days > 1 && days < 7) {
        return formatDate(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    }
    if (at.getFullYear() === new Date(now).getFullYear()) {
        return formatDate(ms, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        })
    }
    return formatDate(ms, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * How long an ended transfer ran. Uses the duration reported by rclone when there is one, and
 * otherwise the start and end times stored with the transfer.
 */
export function durationOf(transfer: Transfer): number {
    if (transfer.stats?.durationMs) return transfer.stats.durationMs
    if (transfer.endedAt === null) return 0
    return Math.max(0, transfer.endedAt - (transfer.startedAt ?? transfer.createdAt))
}

export function bytesOf(bytes: number, totalBytes: number): string {
    const done = formatBytes(bytes)
    const total = formatBytes(totalBytes)
    return t({
        message: `${done} of ${total}`,
        comment: 'How much of a transfer has moved: "1.2 GB of 4 GB".',
    })
}

/** How much an ended transfer moved: its bytes and files, or else the files it checked. */
function amountOf(transfer: Transfer): string[] {
    const stats = transfer.stats
    if (!stats) return []
    const { bytes, transfers: files, checks } = stats
    const parts: string[] = []
    if (bytes > 0) parts.push(formatBytes(bytes))
    if (files > 0) parts.push(plural(files, { one: '# file', other: '# files' }))
    if (parts.length === 0 && checks > 0) {
        parts.push(
            t({
                message: plural(checks, { one: '# checked', other: '# checked' }),
                comment: 'How many files a transfer compared, when it moved nothing: "30 checked".',
            })
        )
    }
    return parts
}

/**
 * The line that a row shows after its transfer's number. While the transfer runs, the line comes
 * from `live`, the latest progress: "Preparing · 1,200 listed" or "1.2 GB of 4 GB · 3 min left".
 * A completed transfer says what it moved and in how long ("4.2 GB · 12 files · in 6 min"), and
 * a failed one gives the first line of its error. The parts are joined with " · ", which
 * separates them in every language.
 */
export function statusOf(transfer: Transfer, live: TransferProgress | null | undefined): string {
    switch (transfer.state) {
        case 'queued':
            return t`Waiting to start`
        case 'running': {
            const phase = phaseOf(transfer.state, live)
            if (phase === 'preparing') {
                const preparing = t({
                    message: 'Preparing',
                    comment: 'A transfer that is listing the files before it starts.',
                })
                const listed = live?.listed ?? 0
                if (listed === 0) return preparing
                const count = t({
                    message: plural(listed, { one: '# listed', other: '# listed' }),
                    comment: 'How many files and folders a transfer has listed so far.',
                })
                return [preparing, count].join(' · ')
            }
            if (phase === 'checking') {
                const checking = live?.checking.length ?? 0
                return plural(checking, { one: 'Checking # file', other: 'Checking # files' })
            }
            const bytes = live?.bytes ?? 0
            const total = live?.totalBytes ?? 0
            const parts = [total > 0 ? bytesOf(bytes, total) : formatBytes(bytes)]
            if (live?.eta) {
                const duration = formatDuration(live.eta * 1000)
                parts.push(
                    t({
                        message: `${duration} left`,
                        comment: 'How long a transfer has left: "3 min left".',
                    })
                )
            }
            return parts.join(' · ')
        }
        case 'completed': {
            const amount = amountOf(transfer)
            if (amount.length === 0) return ''
            const duration = formatDuration(durationOf(transfer))
            const took = t({
                message: `in ${duration}`,
                comment:
                    'How long a finished transfer took, after what it moved: "4.2 GB · 12 files · in 6 min".',
            })
            return [...amount, took].join(' · ')
        }
        case 'failed':
            // The error comes from the core in the app's language.
            return transfer.error.split('\n')[0].trim() || t`Open the transfer to see why.`
        default:
            return ''
    }
}

/** The chip of an ended row: "Finished", "Failed", "Stopped at 42%" or "Interrupted". */
export function standingOf(transfer: Transfer) {
    const ended = ENDED[transfer.state]
    if (!ended) return null
    if (transfer.state !== 'stopped') return ended
    const stats = transfer.stats
    const share = formatNumber(percent(stats?.bytes ?? 0, stats?.totalBytes ?? 0) / 100, {
        style: 'percent',
    })
    return {
        ...ended,
        label: t({
            message: `Stopped at ${share}`,
            comment: 'A transfer that the user stopped, with how far it got: "Stopped at 42%".',
        }),
    }
}

/** The places worth a word on a transfer's row: every origin but an operation page. */
export type NamedOrigin = Exclude<`${Transfers.OriginKind}`, '' | 'page'>

/**
 * Where a transfer was started from, or null when the row doesn't name it. Most transfers start
 * on an operation's page, which isn't named.
 */
export function originOf(origin: Pick<Transfers.Origin, 'kind'>): NamedOrigin | null {
    switch (origin.kind) {
        case 'schedule':
        case 'template':
        case 'commander':
        case 'watcher':
        case 'agent':
            return origin.kind
        default:
            return null
    }
}

/**
 * The timing shown last in the summary. For an ended transfer, this is how long it took. For a
 * running one, it is the time left, or how long it has run while rclone has no estimate yet.
 * A queued transfer has no timing.
 */
export function timingOf(
    transfer: Transfer,
    live: TransferProgress | null | undefined,
    now = Date.now()
): { label: string; value: string } | null {
    if (transfer.state === 'queued') return null
    if (transfer.endedAt !== null) {
        return {
            label: t({ message: 'Duration', comment: 'How long a transfer took.' }),
            value: formatDuration(durationOf(transfer)),
        }
    }
    if (live?.eta) {
        return {
            label: t({ message: 'Time left', comment: 'How long a running transfer has left.' }),
            value: formatDuration(live.eta * 1000),
        }
    }
    return {
        label: t({
            message: 'Running for',
            comment: 'Above how long a transfer has run so far, while its time left is unknown.',
        }),
        value: formatDuration(now - (transfer.startedAt ?? transfer.createdAt)),
    }
}

/**
 * The day that the list puts an ended transfer under: "Today", "Yesterday", the weekday within
 * the past week ("Monday"), then the date ("12 March", or "12 March 2024" before this year).
 */
export function dayOf(ms: number, now = Date.now()): string {
    const at = new Date(ms)
    const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
    if (days === 0) {
        return t({ message: 'Today', comment: 'A heading over the transfers that ended today.' })
    }
    if (days === 1) {
        return t({
            message: 'Yesterday',
            comment: 'A heading over the transfers that ended yesterday.',
        })
    }
    if (days > 1 && days < 7) return formatDate(ms, { weekday: 'long' })
    if (at.getFullYear() === new Date(now).getFullYear()) {
        return formatDate(ms, { day: 'numeric', month: 'long' })
    }
    return formatDate(ms, { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Splits ended transfers, newest first, into runs of the same day, keeping their order. A
 * transfer counts on the day it ended.
 */
export function byDay<T extends Pick<Transfer, 'endedAt' | 'createdAt'>>(
    transfers: readonly T[],
    now = Date.now()
): { day: string; items: T[] }[] {
    const days: { key: number; day: string; items: T[] }[] = []
    for (const transfer of transfers) {
        const at = transfer.endedAt ?? transfer.createdAt
        const key = startOfDay(at)
        const last = days.at(-1)
        if (last?.key === key) last.items.push(transfer)
        else days.push({ key, day: dayOf(at, now), items: [transfer] })
    }
    return days.map(({ day, items }) => ({ day, items }))
}
