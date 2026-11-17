import rclone from '../rclone/client'
import type { BatchInput } from '../rclone/requests'
import type { JobStatusLike } from './results'

export interface SubmittedCopyVerifyJob {
    jobId: number
    executeId: string
}

export interface JobListSnapshot {
    executeId: string
    jobids: number[]
    runningIds: number[]
    finishedIds: number[]
}

export interface GroupStatsSnapshot {
    checks?: number
    [key: string]: unknown
}

function assertSubmittedJob(value: unknown): SubmittedCopyVerifyJob {
    const response = value as { jobid?: unknown; executeId?: unknown }
    if (typeof response?.jobid !== 'number' || typeof response.executeId !== 'string') {
        throw new Error('rclone did not return a usable async job reference')
    }
    return { jobId: response.jobid, executeId: response.executeId }
}

export async function submitCopyVerifyBatch(
    inputs: BatchInput[],
    group: string
): Promise<SubmittedCopyVerifyJob> {
    const response = await rclone('/job/batch', {
        body: {
            inputs: inputs.map((input) => ({ ...input, _group: group })),
            _async: true,
        },
    })
    return assertSubmittedJob(response)
}

export async function getJobList(): Promise<JobListSnapshot> {
    const response = (await rclone('/job/list', { body: {} })) as unknown as JobListSnapshot
    if (!response || typeof response.executeId !== 'string' || !Array.isArray(response.jobids)) {
        throw new Error('rclone returned an invalid job list')
    }
    return response
}

export async function getJobStatus(jobId: number): Promise<JobStatusLike> {
    return (await rclone('/job/status', { body: { jobid: jobId } })) as unknown as JobStatusLike
}

export async function getGroupStats(group: string): Promise<GroupStatsSnapshot> {
    return (await rclone('/core/stats', { body: { group } })) as unknown as GroupStatsSnapshot
}

export async function stopCopyVerifyGroup(group: string): Promise<void> {
    await rclone('/job/stopgroup', { body: { group } })
}

export class RcloneDaemonChangedError extends Error {
    constructor() {
        super('The rclone daemon changed while Copy + Verify was running')
        this.name = 'RcloneDaemonChangedError'
    }
}

export async function waitForCopyVerifyJob(
    job: SubmittedCopyVerifyJob,
    options: { pollMs?: number; signal?: AbortSignal } = {}
): Promise<JobStatusLike> {
    const pollMs = options.pollMs ?? 500
    while (true) {
        if (options.signal?.aborted) throw new Error('Copy + Verify was stopped')
        const list = await getJobList()
        if (list.executeId !== job.executeId) throw new RcloneDaemonChangedError()
        const status = await getJobStatus(job.jobId)
        if (status.finished) return status
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, pollMs)
            options.signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(timeout)
                    reject(new Error('Copy + Verify was stopped'))
                },
                { once: true }
            )
        })
    }
}
