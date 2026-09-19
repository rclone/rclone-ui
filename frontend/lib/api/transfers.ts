// Transfers as the server records them (`src/transfers/`): started by it, watched by
// it, written by it. The list, the details, starting and stopping all go through here; rclone is
// asked for nothing but the live numbers of what is running (`lib/transfers/live.ts`).

import { rpc } from './rpc'

export type TransferState =
    | 'running'
    | 'completed'
    | 'failed'
    /** Stopped from the app. */
    | 'stopped'
    /** Its rclone daemon went away under it. */
    | 'interrupted'
    /** It ended while nothing was watching, and rclone no longer remembers how. */
    | 'unknown'

/**
 * Where a transfer came from: a schedule's run, an operation's page, the Commander. Only the
 * server writes `schedule`, for a run it started itself; it drops that tag from what a page
 * sends.
 */
export type TransferTag = 'schedule' | 'operation' | 'commander'

export interface TransferStats {
    bytes: number
    totalBytes: number
    transfers: number
    checks: number
    errors: number
    durationMs: number
}

/** A transfer as the record has it: its `started` line with its end beside it. What one does
 * not have is absent. */
export interface TransferEntry {
    id: string
    /** When it started. */
    ts: string
    /** rclone's name for the daemon process that took it. */
    executeId: string
    /** rclone's own id for the job. It starts over with every daemon; `id` is what names a transfer. */
    jobid: number
    operation: string
    sources: string[]
    destination?: string
    isDryRun: boolean
    /** What the page had set when it started this (an `OperationPreset`), for Reuse settings. */
    preset?: unknown
    /** Set on a scheduled run: the schedule, its name then, and the run. */
    taskId?: string
    taskName?: string
    runId?: string
    /** The transfer this one retries the failures of. */
    retryOf?: string
    /** Where it came from (`TransferTag`; a string, so one from a newer server still reads). */
    tags: string[]
    state: TransferState
    finishedAt: string | null
    error: string | null
    stats: TransferStats | null
}

/** A file as `core/transferred` lists it (rclone's own shape; only what the app reads is named). */
export interface TransferredFile {
    name?: string
    error?: string
    /** Skipped, or only looked at: not a transfer. */
    checked?: boolean
    /** What rclone was doing with it: transferring, moving, deleting, checking, … */
    what?: string
    /** Its ends, in rclone's canonical form, which is not the string the request gave. */
    srcFs?: string
    dstFs?: string
    size?: number
    completed_at?: string
}

/**
 * What a transfer left behind. `request` is there from its start; the rest is written when it
 * ends. `failed` was collected while it ran (rclone only remembers a job's last 100 files, so a
 * long transfer's early failures are gone from `transferred` by the end).
 */
export interface TransferDetail {
    request?: { endpoint: string; body: Record<string, unknown> }
    status?: {
        error?: string
        /** A batch: one result per input, in order; a failed one carries its error. */
        output?: { results?: { error?: string; input?: Record<string, unknown> }[] } | null
    }
    transferred?: TransferredFile[] | null
    /** At most the first thousand (`MAX_FAILED`). */
    failed?: TransferredFile[]
}

/** A request the page's builders made (`lib/rclone/requests.ts`), and what to remember of it. */
export interface TransferStart {
    operation: string
    sources?: string[]
    destination?: string
    isDryRun: boolean
    preset?: unknown
    /** The transfer this one retries the failures of. */
    retryOf?: string
    tags?: TransferTag[]
    request: { endpoint: string; body: Record<string, unknown> }
}

export const transfersList = (limit?: number) =>
    rpc<TransferEntry[]>('transfers_list', { limit: limit ?? null })

export const transfersDetail = (id: string) =>
    rpc<TransferDetail | null>('transfers_detail', { id })

/** Submits and records in one step; an early failure of the launch is this call's error. */
export const transfersStart = (transfer: TransferStart) =>
    rpc<{ id: string; jobid: number }>('transfers_start', { transfer })

export const transfersStop = (id: string) => rpc<null>('transfers_stop', { id })
