import { rcFetch } from '../api/rc'
import type { TransferDetail, TransferEntry, TransferredFile } from '../api/transfers'
import rclone from '../rclone/client'
import type { LiveStats } from './rows'

// The one place the app asks rclone about its jobs: the live numbers of what is running.
// What exists, what ran and how it ended is the server's record (`lib/api/transfers.ts`); no
// list of transfers is ever made from what rclone answers here. (`e2e/transfers.spec.ts` holds
// the rest of the source to that.)

/** What rclone says of a running job right now, in one go. */
export interface LiveJob {
    /** Its `job/status`; null when the daemon does not hold the job (any more). */
    status: TransferDetail['status'] | null
    transferring: {
        name?: string
        size?: number
        bytes?: number
        speed?: number
        percentage?: number
    }[]
    checking: { name?: string; size?: number }[]
    transferred: TransferredFile[]
}

/**
 * A running job's state, its files in flight and the files it is done with, by rclone's id. The
 * status is read raw: a finished job that failed answers with its `error`, which the client
 * would throw, taking the files of that last look with it.
 */
export async function liveJob(jobid: number): Promise<LiveJob> {
    const group = `job/${jobid}`
    const [status, stats, done] = await Promise.all([
        rcFetch('job/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobid }),
        }).then((response) =>
            response.ok ? (response.json() as Promise<LiveJob['status']>) : null
        ),
        rclone('/core/stats', { params: { query: { group } } }),
        rclone('/core/transferred', { params: { query: { group } } }),
    ])
    return {
        status,
        transferring: (stats?.transferring ?? []) as LiveJob['transferring'],
        checking: (stats?.checking ?? []) as LiveJob['checking'],
        transferred: (done?.transferred ?? []) as TransferredFile[],
    }
}

/**
 * Whether the daemon has files in flight right now, whoever started them. For the questions
 * that ask "would this interrupt something?", after the record has answered for the transfers:
 * a job put on the daemon by something other than this app is in no record, and shows here.
 */
export async function isMoving(): Promise<boolean> {
    try {
        const response = await rcFetch('core/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        if (!response.ok) return false
        const stats = (await response.json()) as { transferring?: unknown[]; checking?: unknown[] }
        return (stats.transferring?.length ?? 0) > 0 || (stats.checking?.length ?? 0) > 0
    } catch {
        return false
    }
}

/** Whether rclone can be asked about this transfer from here. */
export function isLive(entry: TransferEntry) {
    // Every transfer is on the daemon this client talks to, a scheduled run included: whether
    // it is still going is the only question left.
    return entry.state === 'running'
}

/** Live numbers by transfer id. A transfer rclone can't answer for is simply not in the result. */
export async function fetchLive(entries: TransferEntry[]): Promise<Record<string, LiveStats>> {
    const answers = await Promise.all(
        entries.filter(isLive).map(async (entry) => {
            try {
                const stats = await rclone('/core/stats', {
                    params: { query: { group: `job/${entry.jobid}` } },
                })
                const live: LiveStats = {
                    bytes: stats.bytes ?? 0,
                    totalBytes: stats.totalBytes ?? 0,
                    speed: stats.speed ?? 0,
                    listed: (stats as { listed?: number }).listed ?? 0,
                    transferring: stats.transferring?.length ?? 0,
                    checking: stats.checking?.length ?? 0,
                    transfers: stats.transfers ?? 0,
                    errors: stats.errors ?? 0,
                }
                return [entry.id, live] as const
            } catch {
                return null
            }
        })
    )
    return Object.fromEntries(answers.filter((answer) => answer !== null))
}
