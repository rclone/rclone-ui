import { useQuery } from '@tanstack/react-query'
import queryClient from '@/lib/query'
import { rpc } from '@/server/rpc'
import { on } from '@/server/ws'
import { describeSources } from './rclone/kinds'
import {
    type BisyncArgs,
    type CopyArgs,
    type DeleteArgs,
    type MoveArgs,
    type PurgeArgs,
    type RcRequest,
    type SyncArgs,
    type TaskRequestInput,
    buildTaskRequests,
    configParamOf,
} from './rclone/requests'
import { pathsFromArgs } from './rclone/templatePaths'

// Schedules are the server's: one task file each (src/scheduler/taskfile.rs), listed from it,
// saved whole to it. The list is a query, reloaded when the server says a schedule changed or a
// run of one started or ended (`schedules.changed`).

/** A schedule as the page edits it: the form the server keeps whole in the task file. */
export type ScheduledTask = {
    id: string
    name?: string
    cron: string
    /**
     * Max run time in whole hours (1-120); the run stops its transfer when it's exceeded.
     * Default 24 when absent.
     */
    maxRunHours?: number
    /**
     * What each source is, file or folder, as rclone answered when the task was saved: its
     * requests are built from this, and rebuilt from it without asking again.
     */
    kinds?: Record<string, 'file' | 'folder'>
} & (
    | {
          operation: 'delete'
          args: DeleteArgs
      }
    | {
          operation: 'sync'
          args: SyncArgs
      }
    | {
          operation: 'copy'
          args: CopyArgs
      }
    | {
          operation: 'move'
          args: MoveArgs
      }
    | {
          operation: 'purge'
          args: PurgeArgs
      }
    | {
          operation: 'bisync'
          args: BisyncArgs
      }
)

/** What a run executes: built from the task by the request builders when it is saved. */
export interface SchedulerJobSpec {
    name: string
    operation: ScheduledTask['operation']
    cron: string
    maxRunSeconds: number
    /** What the task runs on, as the page shows it: each run's transfer is recorded with these. */
    sources: string[]
    destination?: string
    requests: RcRequest[]
}

export interface LastFinished {
    runId: string
    ts: string
    success: boolean
    error?: string
    durationMs: number
    jobids?: number[]
    stats?: { bytes?: number; transfers?: number; errors?: number }
    /** Synthesized: the run left a started event but no finished one (crash/power loss). */
    interrupted?: boolean
}

/** A schedule as the server lists it: the task, whether it is on, and where it stands. */
export type Schedule = ScheduledTask & {
    isEnabled: boolean
    createdAt?: number
    running: boolean
    lastFinished?: LastFinished
    /** The next local fire times (RFC3339), by the tick's own matcher. */
    nextRuns: string[]
}

/** The wire shape of `scheduler_list` and `scheduler_save`. */
interface Listed {
    id: string
    enabled: boolean
    createdAt?: number
    task: Omit<ScheduledTask, 'id'>
    running: boolean
    lastFinished?: LastFinished
    nextRuns: string[]
}

export type SchedulerHistoryLine =
    | { event: 'started'; runId: string; ts: string }
    | {
          event: 'finished'
          runId: string
          ts: string
          success: boolean
          error?: string
          durationMs: number
          jobids?: number[]
          stats?: { bytes?: number; transfers?: number; errors?: number }
      }
    | { event: 'skipped'; ts: string; reason: string }

/** Max run time bounds, in hours. The wire format (`maxRunSeconds`) stays in seconds. */
export const DEFAULT_MAX_RUN_HOURS = 24
export const MAX_RUN_HOURS_LIMIT = 120

function clampMaxRunHours(hours: number | undefined): number {
    if (!Number.isFinite(hours)) {
        return DEFAULT_MAX_RUN_HOURS
    }
    return Math.min(Math.max(Math.round(hours as number), 1), MAX_RUN_HOURS_LIMIT)
}

export const SCHEDULES_KEY = ['schedules'] as const

function toSchedule(listed: Listed): Schedule {
    return {
        ...(listed.task as ScheduledTask),
        id: listed.id,
        isEnabled: listed.enabled,
        createdAt: listed.createdAt,
        running: listed.running,
        lastFinished: listed.lastFinished,
        nextRuns: listed.nextRuns,
    }
}

export async function listSchedules(): Promise<Schedule[]> {
    return (await rpc<Listed[]>('scheduler_list')).map(toSchedule)
}

/**
 * Every schedule, kept current: the server says when one changed or a run started or ended.
 * The next fire times are anchored at fetch time, so the list is asked again each minute.
 */
export function useSchedules() {
    return useQuery({ queryKey: SCHEDULES_KEY, queryFn: listSchedules, refetchInterval: 60_000 })
}

on('schedules.changed', () => {
    queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY })
})

export interface CronValidation {
    valid: boolean
    error?: string
    /** Next local fire times (RFC3339), computed by the same Rust matcher the tick uses —
     * the only preview that cannot disagree with what will actually fire. */
    nextRuns: string[]
}

export async function schedulerValidateCron(cron: string) {
    return rpc<CronValidation>('scheduler_validate_cron', { cron })
}

export async function schedulerReadHistory(taskId: string, limit?: number) {
    return rpc<SchedulerHistoryLine[]>('scheduler_read_history', { taskId, limit })
}

export async function schedulerRunNow(taskId: string) {
    return rpc('scheduler_run_now', { taskId })
}

/** What the scheduler said about this task's runs. What each run moved is its transfer's. */
export async function schedulerReadLog(taskId: string) {
    return rpc<{ content: string; truncated: boolean }>('scheduler_read_log', { taskId })
}

function buildJobSpec(task: ScheduledTask): SchedulerJobSpec {
    // One-source operations keep theirs under `source`, the rest under `sources`.
    const args = task.args as { sources?: string[]; source?: string; destination?: string }
    return {
        name: task.name ?? task.operation,
        operation: task.operation,
        cron: task.cron,
        maxRunSeconds: clampMaxRunHours(task.maxRunHours) * 3600,
        sources: args.sources ?? (args.source ? [args.source] : []),
        destination: args.destination,
        // Pre-serialized here, at save time, by the exact same builders the live start* path
        // uses — a run just hands them over. Throws when the args can't serialize. What the
        // sources are (file or folder) is what rclone said when the task was saved
        // (`task.kinds`): a later save (enable, a cron edit, a remote rename) does not ask again.
        requests: buildTaskRequests(task, task.kinds),
    }
}

/** The task, whole, to the server: the form it keeps, and the requests a run will submit. */
async function save(task: ScheduledTask, enabled: boolean): Promise<Schedule> {
    const { id, ...form } = task
    const listed = await rpc<Listed>('scheduler_save', {
        schemaVersion: 1,
        id,
        enabled,
        task: form,
        spec: buildJobSpec(task),
    })
    return toSchedule(listed)
}

async function assertValidCron(cron: string) {
    const validation = await schedulerValidateCron(cron)
    if (!validation.valid) {
        throw new Error(validation.error ?? 'Invalid cron expression')
    }
}

/** Creates a schedule, on, and returns its id. What its sources are is asked of rclone once. */
export async function createSchedule(input: {
    name: string
    operation: ScheduledTask['operation']
    cron: string
    args: ScheduledTask['args']
}): Promise<string> {
    await assertValidCron(input.cron)
    // (Callers guarantee the operation/args correlation via useScheduleTask's generic; Omit<>
    // flattens the discriminated union, hence the casts.)
    const request = { operation: input.operation, args: input.args } as TaskRequestInput
    const kinds = await describeSources(pathsFromArgs(input.args).sources ?? [], {
        configParam: configParamOf(request),
        remotes: input.args.options.remotes,
    })
    const task = {
        id: crypto.randomUUID(),
        name: input.name,
        operation: input.operation,
        cron: input.cron,
        args: input.args,
        kinds,
    } as ScheduledTask
    return (await save(task, true)).id
}

/**
 * Changes a schedule and saves it whole. Its requests are rebuilt from the kinds saved with it,
 * so rclone is not asked again and the save does not depend on the sources being reachable.
 */
export async function updateSchedule(
    id: string,
    patch: Partial<ScheduledTask> & { isEnabled?: boolean }
): Promise<void> {
    if (patch.cron) await assertValidCron(patch.cron)
    const current = (await listSchedules()).find((schedule) => schedule.id === id)
    if (!current) {
        throw new Error('Task not found')
    }
    const { isEnabled: was, running: _r, lastFinished: _l, nextRuns: _n, createdAt: _c, ...task } =
        current
    const { isEnabled, ...changes } = patch
    await save({ ...task, ...changes } as ScheduledTask, isEnabled ?? was)
}

export async function removeSchedule(id: string): Promise<void> {
    await rpc('scheduler_remove', { taskId: id })
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    await rpc('scheduler_set_enabled', { taskId: id, enabled })
}
