import type { TransferEntry, TransferState } from '../api/transfers'

// The Transfers list: the server's record, overlaid with rclone's live numbers for whatever is
// still running. Pure, so the node-side spec runs it as it is. The list exists without rclone;
// only the numbers of a running row need it.

/** What `core/stats?group=job/N` says about one running transfer. */
export interface LiveStats {
    bytes: number
    totalBytes: number
    speed: number
    /** Entries rclone has listed so far: the only number there is before a file moves. */
    listed: number
    transferring: number
    checking: number
    /** Files done and errors met so far. */
    transfers: number
    errors: number
}

/** A row is its entry, with where it stands beside it. */
export type TransferRow = TransferEntry & {
    type: 'active' | 'inactive'
    bytes: number
    totalBytes: number
    speed: number
    progress: number
    /** Where a running transfer is; null once it has ended. */
    phase: 'preparing' | 'checking' | 'transferring' | null
    listed: number
    checkingCount: number
    /** Files it moved and errors it met: so far while it runs, in all once it has ended. */
    fileCount: number
    errorCount: number
    /** A scheduled run: its row belongs to the Schedules page. */
    scheduled: { taskId: string; runId?: string; name?: string } | null
}

/** How a transfer that is over says so: in the list, its drawer and on the Dashboard. */
export const ENDED: Record<
    Exclude<TransferState, 'running'>,
    { label: string; color: 'primary' | 'danger' | 'warning' | 'default' }
> = {
    completed: { label: 'Finished', color: 'primary' },
    failed: { label: 'Failed', color: 'danger' },
    stopped: { label: 'Stopped', color: 'default' },
    interrupted: { label: 'Interrupted', color: 'warning' },
    unknown: { label: 'Outcome unknown', color: 'default' },
}

/**
 * Whether a schedule ran it: its row belongs to the Schedules page, and rclone cannot be asked
 * about it from here (a run has a daemon of its own). Its tag says so. The task and run ids
 * beside it only say which schedule and which run.
 */
export function isScheduled(entry: TransferEntry) {
    return entry.tags.includes('schedule')
}

function percent(bytes: number, totalBytes: number) {
    return totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0
}

function toRow(entry: TransferEntry, live: LiveStats | undefined): TransferRow {
    const isRunning = entry.state === 'running'
    // A finished transfer's numbers are the record's, whatever its stats group still answers.
    const numbers = isRunning ? live : undefined
    const bytes = numbers?.bytes ?? entry.stats?.bytes ?? 0
    const totalBytes = numbers?.totalBytes ?? entry.stats?.totalBytes ?? 0
    const phase = !isRunning
        ? null
        : numbers && (numbers.transferring > 0 || numbers.bytes > 0)
          ? 'transferring'
          : numbers && numbers.checking > 0
            ? 'checking'
            : 'preparing'
    return {
        ...entry,
        type: isRunning ? 'active' : 'inactive',
        bytes,
        totalBytes,
        speed: numbers?.speed ?? 0,
        // Complete is complete, even when everything was already there and nothing moved.
        progress: entry.state === 'completed' ? 100 : percent(bytes, totalBytes),
        phase,
        listed: numbers?.listed ?? 0,
        checkingCount: numbers?.checking ?? 0,
        fileCount: numbers?.transfers ?? entry.stats?.transfers ?? 0,
        errorCount: numbers?.errors ?? entry.stats?.errors ?? 0,
        scheduled:
            isScheduled(entry) && entry.taskId
                ? { taskId: entry.taskId, runId: entry.runId, name: entry.taskName }
                : null,
    }
}

/** `entries` come newest first and stay so; `live` is keyed by transfer id. */
export function toRows(entries: TransferEntry[], live: Record<string, LiveStats | undefined>) {
    const rows = entries.map((entry) => toRow(entry, live[entry.id]))
    return {
        active: rows.filter((row) => row.type === 'active'),
        inactive: rows.filter((row) => row.type === 'inactive'),
    }
}

/**
 * What the transfers of a window moved: those that ended in it, and those still running. Dry
 * runs moved nothing. These are the record's figures, so they are about transfers and nothing
 * else: rclone's own counters take in every file the daemon touches (a saved rclone.conf is
 * "1 file" to it).
 */
export function totalsOf(rows: TransferRow[], since: number, now = Date.now()) {
    const totals = { bytes: 0, files: 0, errors: 0 }
    for (const row of rows) {
        const ended = row.finishedAt ? Date.parse(row.finishedAt) : now
        if (row.isDryRun || ended < since) continue
        totals.bytes += row.bytes
        totals.files += row.fileCount
        totals.errors += row.errorCount
    }
    return totals
}
