import { useQuery } from '@tanstack/react-query'

import { usePersistedStore } from '@/store'
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
import { rpc } from '@/server/rpc'

export type ScheduledTask = {
    id: string
    name?: string
    cron: string
    isEnabled: boolean
    /**
     * Max run time in whole hours (1-120); the run stops its transfer when it's exceeded.
     * Default 24 when absent.
     */
    maxRunHours?: number
    /**
     * Set when the last registration attempt failed (an unparseable cron, a write that did not
     * land). Persisted so a disabled task can explain itself across restarts.
     */
    registrationError?: string
    /**
     * What each source is, file or folder, as rclone answered when the task was saved: its
     * job file is built from this, and rebuilt from it without asking again.
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

// Orchestration between the zustand host store (task definitions — the source of truth) and the
// server's scheduler (registration reality). Registration is always an upsert, so the startup
// reconcile() self-heals a registration that was lost or never written.

export interface SchedulerSupport {
    supported: boolean
    reason?: string
}

export interface SchedulerJobSpec {
    schemaVersion: 1
    taskId: string
    name: string
    operation: ScheduledTask['operation']
    cron: string
    maxRunSeconds: number
    /** What the task runs on, as the page shows it: each run's transfer is recorded with these. */
    sources: string[]
    destination?: string
    requests: RcRequest[]
}

export interface SchedulerTaskStatus {
    taskId: string
    installed: boolean
    enabled: boolean
    running: boolean
    lastFinished?: {
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
    /** Why the task's state could not be established — its registration could not be read. */
    warning?: string
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

/** Max run time bounds, in hours. The wire format (JobSpec.maxRunSeconds) stays in seconds. */
export const DEFAULT_MAX_RUN_HOURS = 24
export const MAX_RUN_HOURS_LIMIT = 120

function clampMaxRunHours(hours: number | undefined): number {
    if (!Number.isFinite(hours)) {
        return DEFAULT_MAX_RUN_HOURS
    }
    return Math.min(Math.max(Math.round(hours as number), 1), MAX_RUN_HOURS_LIMIT)
}

let cachedSupport: SchedulerSupport | null = null

export async function schedulerSupported(): Promise<SchedulerSupport> {
    if (!cachedSupport) {
        cachedSupport = await rpc<SchedulerSupport>('scheduler_supported')
    }
    return cachedSupport
}

export function useSchedulerSupported() {
    return useQuery({
        queryKey: ['scheduler', 'supported'],
        queryFn: schedulerSupported,
        staleTime: Number.POSITIVE_INFINITY,
    })
}

/**
 * Whether scheduling can actually work here. The server is its own scheduler, so this is yes
 * unless it could not read its registrations at all. Unresolved counts as unavailable. Shared by
 * the operation pages (to gate the Schedule section + footer Schedule button) and the footer.
 */
export function useSchedulingAvailable(): boolean {
    return useSchedulerSupported().data?.supported ?? false
}

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

export async function schedulerStatus() {
    return rpc<SchedulerTaskStatus[]>('scheduler_status', {})
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
        schemaVersion: 1,
        taskId: task.id,
        name: task.name ?? task.operation,
        operation: task.operation,
        cron: task.cron,
        maxRunSeconds: clampMaxRunHours(task.maxRunHours) * 3600,
        sources: args.sources ?? (args.source ? [args.source] : []),
        destination: args.destination,
        // Pre-serialized here, at save time, by the exact same builders the live start* path
        // uses — a run just hands them over. Throws when the args can't serialize. What the
        // sources are (file or folder) is what rclone said when the task was saved
        // (`task.kinds`): a later rebuild (enable, a cron edit, a remote rename) does not ask again.
        requests: buildTaskRequests(task, task.kinds),
    }
}

async function registerTask(task: ScheduledTask): Promise<void> {
    const spec = buildJobSpec(task)
    // One command: the task is registered directly in its enabled state, so a disabled one is
    // never briefly armed.
    await rpc('scheduler_register', { spec, enabled: task.isEnabled })
}

async function assertSupported() {
    const support = await schedulerSupported()
    if (!support.supported) {
        throw new Error(support.reason ?? 'Scheduling is not available on this system')
    }
}

/**
 * Creates a task, registers it with the scheduler, and returns its id. On registration failure
 * the task is kept (with the error stored on it) — never silently lost; the startup reconcile
 * retries. isEnabled always reflects user intent, never the registration's state.
 */
export async function createScheduledTask(input: {
    name: string
    operation: ScheduledTask['operation']
    cron: string
    args: ScheduledTask['args']
}): Promise<string> {
    await assertSupported()

    const validation = await schedulerValidateCron(input.cron)
    if (!validation.valid) {
        throw new Error(validation.error ?? 'Invalid cron expression')
    }

    const hostState = usePersistedStore.getState()

    // What the sources are is rclone's answer, asked now and saved with the task, never asked
    // again. (Callers guarantee the operation/args correlation via useScheduleTask's generic;
    // Omit<> flattens the discriminated union, hence the casts.)
    const request = { operation: input.operation, args: input.args } as TaskRequestInput
    const kinds = await describeSources(pathsFromArgs(input.args).sources ?? [], {
        configParam: configParamOf(request),
        remotes: input.args.options.remotes,
    })
    const task = {
        name: input.name,
        operation: input.operation,
        cron: input.cron,
        args: input.args,
        kinds,
        isEnabled: true,
    } as Omit<ScheduledTask, 'id'>

    // Serialization must succeed before anything persists.
    buildTaskRequests(request, kinds)

    const id = hostState.addScheduledTask(task)
    const stored = usePersistedStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!stored) {
        throw new Error('Failed to save the scheduled task')
    }

    try {
        await registerTask(stored)
    } catch (error) {
        const registrationError = error instanceof Error ? error.message : String(error)
        usePersistedStore.getState().updateScheduledTask(id, { registrationError })
        throw new Error(
            `The schedule was saved but could not be registered with the scheduler: ${registrationError}`
        )
    }

    return id
}

/** Updates a task and re-registers it (upsert). */
export async function updateScheduledTask(
    id: string,
    patch: Partial<ScheduledTask>
): Promise<void> {
    await assertSupported()

    if (patch.cron) {
        const validation = await schedulerValidateCron(patch.cron)
        if (!validation.valid) {
            throw new Error(validation.error ?? 'Invalid cron expression')
        }
    }

    const store = usePersistedStore.getState()
    store.updateScheduledTask(id, { ...patch, registrationError: undefined })
    const merged = usePersistedStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!merged) {
        throw new Error('Task not found')
    }

    try {
        await registerTask(merged)
    } catch (error) {
        const registrationError = error instanceof Error ? error.message : String(error)
        usePersistedStore.getState().updateScheduledTask(id, { registrationError })
        throw new Error(`The task was saved but could not be registered: ${registrationError}`)
    }
}

/**
 * Removes the task. Unregistering removes the job file even when the uninstall itself fails, so
 * a surviving registration self-heals on its next fire: the run finds no job file and takes the
 * registration with it.
 */
export async function removeScheduledTask(id: string): Promise<void> {
    {
        try {
            await rpc('scheduler_unregister', { taskId: id })
        } catch (error) {
            console.error(
                '[scheduler] unregister failed; the registration self-heals on next fire',
                error
            )
        }
    }
    usePersistedStore.getState().removeScheduledTask(id)
}

export async function setScheduledTaskEnabled(id: string, enabled: boolean): Promise<void> {
    const task = usePersistedStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!task) {
        throw new Error('Task not found')
    }

    // Enabling a task whose registration previously failed retries the full registration.
    if (enabled && task.registrationError) {
        await updateScheduledTask(id, { isEnabled: true })
        return
    }

    // Disabling a task whose registration failed: a registration may STILL exist, because a
    // failed edit leaves the previous one armed. The Rust side treats "nothing registered" as
    // success, so always ask it — a real disable failure must surface rather than leave the
    // task firing while the UI says paused.
    if (!enabled && task.registrationError) {
        await rpc('scheduler_set_enabled', { taskId: id, enabled: false })
        usePersistedStore.getState().updateScheduledTask(id, { isEnabled: false })
        return
    }

    // The scheduler first, the store second — a failed call must not leave the UI claiming a
    // state the scheduler does not have.
    await rpc('scheduler_set_enabled', { taskId: id, enabled })
    usePersistedStore.getState().updateScheduledTask(id, { isEnabled: enabled })
}

/**
 * Heals tasks whose registration failed in the page (they carry `registrationError` and have
 * no job file yet): their request serialization is TypeScript-only, so the orchestrator's
 * startup reconcile (which re-registers every task from its job file, unregisters strays and
 * sweeps orphans) can't do it. Runs when the Schedules page mounts; idempotent.
 */
export async function reconcile(): Promise<void> {
    const support = await schedulerSupported()
    if (!support.supported) {
        return
    }
    const failed = usePersistedStore
        .getState()
        .scheduledTasks.filter((task) => task.registrationError)
    for (const { id } of failed) {
        const task = usePersistedStore.getState().scheduledTasks.find((t) => t.id === id)
        if (!task) continue
        try {
            await registerTask(task)
            usePersistedStore
                .getState()
                .updateScheduledTask(task.id, { registrationError: undefined })
        } catch (error) {
            const registrationError = error instanceof Error ? error.message : String(error)
            console.error('[scheduler] failed to register task', task.id, registrationError)
            usePersistedStore.getState().updateScheduledTask(task.id, { registrationError })
        }
    }
}
