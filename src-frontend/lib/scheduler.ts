import { useQuery } from '@tanstack/react-query'

import { useHostStore } from '../store/host'
import { usePersistedStore } from '../store/persisted'
import type { ScheduledTask } from '../types/schedules'
import { LOCAL_HOST_ID } from './hosts'
import { describeSources } from './rclone/kinds'
import {
    type RcRequest,
    type TaskRequestInput,
    buildTaskRequests,
    configParamOf,
} from './rclone/requests'
import { pathsFromArgs } from './rclone/templatePaths'
import { rpc } from './api/rpc'

// Orchestration between the zustand host store (task definitions — the source of truth) and the
// Rust OS scheduler (registration reality). Registration is always an upsert, so the startup
// reconcile() self-heals deleted OS artifacts, moved app bundles, and restored backups.
//
// Scheduling is LOCAL-HOST-ONLY: tasks stored under remote hosts stay inert.

export interface SchedulerSupport {
    supported: boolean
    reason?: string
}

export interface SchedulerJobSpec {
    schemaVersion: 1
    taskId: string
    hostId: string
    name: string
    operation: ScheduledTask['operation']
    cron: string
    configId: string
    binary: 'app-default' | string
    maxRunSeconds: number
    verboseLogging: boolean
    runMode: 'system' | 'user'
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
    /** Backend health warning — installed+enabled but the OS won't fire it (e.g. the macOS
     * background item was toggled off in System Settings). */
    warning?: string
}

export type SchedulerHistoryLine =
    | { event: 'started'; runId: string; ts: string; pid: number; hostId: string }
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
 * Whether scheduling can actually work here: the current host is the local machine AND the OS
 * backend reports support. Unresolved support counts as unavailable. Shared by the operation
 * pages (to gate the Schedule section + footer Schedule button) and the footer.
 */
export function useSchedulingAvailable(): boolean {
    const currentHostId = usePersistedStore((s) => s.currentHostId) ?? LOCAL_HOST_ID
    const support = useSchedulerSupported()
    return currentHostId === LOCAL_HOST_ID && (support.data?.supported ?? false)
}

export interface CronValidation {
    valid: boolean
    error?: string
    /** Next local fire times (RFC3339), computed by the same Rust matcher the runner uses —
     * the only preview source that can't disagree with what the OS schedule will do. */
    nextRuns: string[]
}

export async function schedulerValidateCron(cron: string) {
    return rpc<CronValidation>('scheduler_validate_cron', { cron })
}

export async function schedulerStatus(hostId: string) {
    return rpc<SchedulerTaskStatus[]>('scheduler_status', { hostId })
}

export async function schedulerReadHistory(taskId: string, limit?: number) {
    return rpc<SchedulerHistoryLine[]>('scheduler_read_history', { taskId, limit })
}

export async function schedulerRunNow(taskId: string) {
    return rpc('scheduler_run_now', { taskId })
}

export async function schedulerReadLog(taskId: string, which: 'runner' | 'daemon') {
    return rpc<{ content: string; truncated: boolean }>('scheduler_read_log', {
        taskId,
        which,
    })
}

function buildJobSpec(task: ScheduledTask): SchedulerJobSpec {
    // One-source operations keep theirs under `source`, the rest under `sources`.
    const args = task.args as { sources?: string[]; source?: string; destination?: string }
    return {
        schemaVersion: 1,
        taskId: task.id,
        hostId: LOCAL_HOST_ID,
        name: task.name ?? task.operation,
        operation: task.operation,
        cron: task.cron,
        configId: task.configId,
        binary: task.binaryPath,
        maxRunSeconds: clampMaxRunHours(task.maxRunHours) * 3600,
        verboseLogging: task.verboseLogging ?? false,
        runMode: task.runMode ?? 'user',
        sources: args.sources ?? (args.source ? [args.source] : []),
        destination: args.destination,
        // Pre-serialized here, at save time, by the exact same builders the live start* path
        // uses — the runner just POSTs them. Throws when the args can't serialize. What the
        // sources are (file or folder) is what rclone said when the task was saved
        // (`task.kinds`): a later rebuild (enable, a cron edit, a remote rename) may run under
        // another active config, so it is not asked again.
        requests: buildTaskRequests(task, task.kinds),
    }
}

async function registerTask(task: ScheduledTask): Promise<void> {
    const spec = buildJobSpec(task)
    // One command: the artifact is installed directly in the target enabled state. A separate
    // set_enabled step used to leave disabled tasks briefly armed (and, when it failed, running
    // against the user's intent — or flagged as unregistered although active).
    await rpc('scheduler_register', { spec, enabled: task.isEnabled })
}

function isCurrentHostLocal() {
    return (usePersistedStore.getState().currentHostId ?? LOCAL_HOST_ID) === LOCAL_HOST_ID
}

function assertLocalHost() {
    if (!isCurrentHostLocal()) {
        throw new Error('Scheduling is only available on your local machine')
    }
}

async function assertSupported() {
    const support = await schedulerSupported()
    if (!support.supported) {
        throw new Error(support.reason ?? 'Scheduling is not available on this system')
    }
}

/**
 * Creates a task, registers it with the OS scheduler, and returns its id. On registration
 * failure the task is kept (with the error stored on it) — never silently lost; the startup
 * reconcile retries. isEnabled always reflects user intent, never system state.
 */
export async function createScheduledTask(input: {
    name: string
    operation: ScheduledTask['operation']
    cron: string
    args: ScheduledTask['args']
    /** Defaults to the active config when omitted. */
    configId?: string
    /** Defaults to 'app-default' when omitted. */
    binaryPath?: string
    /** Defaults to 'user' (only runs while logged in) when omitted. */
    runMode?: 'system' | 'user'
}): Promise<string> {
    assertLocalHost()
    await assertSupported()

    const validation = await schedulerValidateCron(input.cron)
    if (!validation.valid) {
        throw new Error(validation.error ?? 'Invalid cron expression')
    }

    const hostState = useHostStore.getState()
    const configId = input.configId ?? hostState.activeConfigId
    if (!configId) {
        throw new Error('No active config file')
    }
    if (!hostState.configFiles.some((config) => config.id === configId)) {
        throw new Error('The selected config file no longer exists')
    }

    // What the sources are is rclone's answer, asked now, while the active config is the
    // task's; it is saved with the task and never asked again. (Callers guarantee the
    // operation/args correlation via useScheduleTask's generic; Omit<> flattens the
    // discriminated union, hence the casts.)
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
        configId,
        binaryPath: input.binaryPath ?? 'app-default',
        runMode: input.runMode ?? 'user',
    } as Omit<ScheduledTask, 'id'>

    // Serialization must succeed before anything persists.
    buildTaskRequests(request, kinds)

    const id = hostState.addScheduledTask(task)
    const stored = useHostStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!stored) {
        throw new Error('Failed to save the scheduled task')
    }

    try {
        await registerTask(stored)
    } catch (error) {
        const registrationError = error instanceof Error ? error.message : String(error)
        useHostStore.getState().updateScheduledTask(id, { registrationError })
        throw new Error(
            `The schedule was saved but could not be registered with the system: ${registrationError}`
        )
    }

    return id
}

/**
 * Updates a task and re-registers it (upsert). On a remote host this is a store-only edit —
 * remote tasks are inert in v1 and must never touch the local OS scheduler.
 */
export async function updateScheduledTask(
    id: string,
    patch: Partial<ScheduledTask>
): Promise<void> {
    if (!isCurrentHostLocal()) {
        useHostStore.getState().updateScheduledTask(id, patch)
        return
    }

    await assertSupported()

    if (patch.cron) {
        const validation = await schedulerValidateCron(patch.cron)
        if (!validation.valid) {
            throw new Error(validation.error ?? 'Invalid cron expression')
        }
    }

    const store = useHostStore.getState()
    store.updateScheduledTask(id, { ...patch, registrationError: undefined })
    const merged = useHostStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!merged) {
        throw new Error('Task not found')
    }

    try {
        await registerTask(merged)
    } catch (error) {
        const registrationError = error instanceof Error ? error.message : String(error)
        useHostStore.getState().updateScheduledTask(id, { registrationError })
        throw new Error(`The task was saved but could not be registered: ${registrationError}`)
    }
}

/**
 * Removes the task. The OS unregister removes the job file even when the OS-level uninstall
 * fails, so a surviving trigger self-heals on its next fire (the runner finds no job file,
 * removes the trigger, and exits). Remote-host tasks are store-only.
 */
export async function removeScheduledTask(id: string): Promise<void> {
    if (isCurrentHostLocal()) {
        try {
            await rpc('scheduler_unregister', { taskId: id, hostId: LOCAL_HOST_ID })
        } catch (error) {
            console.error(
                '[scheduler] unregister failed; the trigger self-heals on next fire',
                error
            )
        }
    }
    useHostStore.getState().removeScheduledTask(id)
}

export async function setScheduledTaskEnabled(id: string, enabled: boolean): Promise<void> {
    const task = useHostStore.getState().scheduledTasks.find((t) => t.id === id)
    if (!task) {
        throw new Error('Task not found')
    }

    // Remote-host tasks are inert — the toggle is a definition-only edit.
    if (!isCurrentHostLocal()) {
        useHostStore.getState().updateScheduledTask(id, { isEnabled: enabled })
        return
    }

    // Enabling a task whose registration previously failed retries the full registration.
    if (enabled && task.registrationError) {
        await updateScheduledTask(id, { isEnabled: true })
        return
    }

    // Disabling a task whose registration failed: an OS artifact may STILL exist (a failed
    // edit leaves the previous artifact active; a failed mode flip can leave one in the other
    // backend). The Rust side sweeps every backend and treats "no artifact anywhere" as
    // success, so always ask it — a real disable failure must surface rather than leave the
    // task firing while the UI says paused.
    if (!enabled && task.registrationError) {
        await rpc('scheduler_set_enabled', { taskId: id, enabled: false })
        useHostStore.getState().updateScheduledTask(id, { isEnabled: false })
        return
    }

    // OS first, store second — a failed OS call must not leave the UI claiming a state the
    // scheduler doesn't have.
    await rpc('scheduler_set_enabled', { taskId: id, enabled })
    useHostStore.getState().updateScheduledTask(id, { isEnabled: enabled })
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
    if (!isCurrentHostLocal()) {
        return
    }
    const failed = useHostStore.getState().scheduledTasks.filter((task) => task.registrationError)
    for (const { id } of failed) {
        const task = useHostStore.getState().scheduledTasks.find((t) => t.id === id)
        if (!task) continue
        try {
            await registerTask(task)
            useHostStore.getState().updateScheduledTask(task.id, { registrationError: undefined })
        } catch (error) {
            const registrationError = error instanceof Error ? error.message : String(error)
            console.error('[scheduler] failed to register task', task.id, registrationError)
            useHostStore.getState().updateScheduledTask(task.id, { registrationError })
        }
    }
}
