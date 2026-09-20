import { type UseMutationResult, useMutation } from '@tanstack/react-query'
import { AlertOctagonIcon, FoldersIcon, PlayIcon } from 'lucide-react'
import { type ReactNode, startTransition, useMemo } from 'react'
import { onErrorDialog } from '../../../lib/errors'
import { pathsProblem } from '../../../lib/paths'
import { startDryRun } from '../../../lib/rclone/api'
import { pathsFromArgs } from '../../../lib/rclone/templatePaths'
import type { FlagValue } from '../../../types/rclone'
import type { TemplatePaths } from '../../../types/template'
import type { ScheduledTask } from '../../../types/schedules'
import { useOperationDryRun } from './useOperationDryRun'
import { useScheduleTask } from './useScheduleTask'

type Operation = ScheduledTask['operation']
type Args = ScheduledTask['args']

/** The same arguments with `dry_run` in the config group: what every dry run submits. */
function withDryRun<A extends Args>(args: A): A {
    return {
        ...args,
        options: { ...args.options, config: { ...(args.options.config ?? {}), dry_run: true } },
    } as A
}

/**
 * What the six transfer pages (Copy, Move, Sync, Bisync, Delete, Purge) share once their
 * paths, option groups and JSX are theirs: one guard for every action (`problem`), the start
 * mutation that keeps the preset's template and schedules when a cron is set, the optional dry
 * run with `dry_run` folded in, the button's text and icon, and the three resets. The page
 * supplies what differs and spreads `footer` into its `OperationFooter`.
 */
export function useOperationSubmission<O extends Operation, A extends Args>({
    operation,
    problem,
    jsonError,
    cron,
    setCron,
    buildArgs,
    buildScheduleArgs,
    start,
    dryRun,
    onStarted,
    getMergedOptions,
    afterStart,
    error,
    reset,
    groups,
}: {
    operation: O
    /** Why the operation cannot start yet, or nothing: the button's text, its disabled state and every action's guard. */
    problem: () => string | undefined
    jsonError: string | null
    cron: string | null
    setCron: (cron: string | null) => void
    buildArgs: () => A
    /** The schedule's arguments where they differ from the live ones (Bisync's outer switches). */
    buildScheduleArgs?: () => Args
    /** A rule the schedule alone has (the multi-source licence gate). */
    start: (args: A) => Promise<unknown>
    /** Present on the pages that offer a preview; called with the dry-run arguments and flag. */
    dryRun?: (args: A, isDryRun: true) => Promise<unknown>
    onStarted: (getOptions: () => Record<string, FlagValue>, getPaths?: () => TemplatePaths) => void
    getMergedOptions: () => Record<string, FlagValue>
    /** A notice after the start (Delete says so), before any scheduling. */
    afterStart?: () => Promise<void>
    error: { title: string; message: string; log: string[] }
    reset: { paths: () => void; extras?: () => void }
    groups: {
        setJsonError: (error: null) => void
        resetJson: () => void
        resetLocks: () => void
    }
}) {
    // The page's own reasons first (a path missing, two the same), then the paths themselves:
    // what rclone would refuse, or read as something else than meant, never leaves the page.
    // The field says what is wrong; the button says which field.
    const problemOrPath = () => {
        const reason = problem()
        if (reason) return reason
        const { sources, destination } = pathsFromArgs(buildArgs())
        if (pathsProblem(sources ?? [])) return 'Fix the source path'
        if (pathsProblem([destination])) return 'Fix the destination path'
        return undefined
    }
    const guard = () => {
        const reason = problemOrPath()
        if (reason) throw new Error(reason)
    }

    const scheduleMutation = useScheduleTask({
        operation,
        cronExpression: cron,
        validate: () => {
            guard()
        },
        buildArgs: buildScheduleArgs ?? buildArgs,
    })

    const startMutation = useMutation({
        mutationFn: async () => {
            guard()
            return start(buildArgs())
        },
        onSuccess: async () => {
            // The run's own arguments say what it ran on, so a plan kept as a template by the
            // Wizard keeps its paths with its flags.
            onStarted(getMergedOptions, () => pathsFromArgs(buildArgs()))
            await afterStart?.()
            if (cron) scheduleMutation.mutate()
        },
        onError: onErrorDialog(error.title, error.message, { log: error.log }),
    })

    const dryRunMutation = useOperationDryRun(async () => {
        guard()
        if (!dryRun) throw new Error('This operation has no dry run')
        return startDryRun((isDryRun) => dryRun(withDryRun(buildArgs()), isDryRun))
    })

    const label = operation.toUpperCase()
    const pending = startMutation.isPending
    const reason = problemOrPath()
    const buttonText = useMemo(() => {
        if (pending) return 'STARTING...'
        if (reason) return reason
        if (jsonError) return `Invalid JSON for ${jsonError.toUpperCase()} options`
        return cron ? `START AND SCHEDULE ${label}` : `START ${label}`
    }, [pending, reason, jsonError, cron, label])
    const buttonIcon = useMemo<ReactNode>(() => {
        if (pending) return undefined
        if (reason) return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-5 h-5" />
        return <PlayIcon className="w-5 h-5 fill-current" />
    }, [pending, reason, jsonError])

    const resetPaths = () =>
        startTransition(() => {
            reset.paths()
            groups.setJsonError(null)
            startMutation.reset()
        })
    const resetOptions = () =>
        startTransition(() => {
            groups.resetJson()
            setCron(null)
            reset.extras?.()
            startMutation.reset()
        })
    const resetAll = () =>
        startTransition(() => {
            groups.resetJson()
            groups.resetLocks()
            setCron(null)
            reset.extras?.()
            reset.paths()
            startMutation.reset()
        })

    return {
        startMutation: startMutation as UseMutationResult<unknown, Error, void>,
        /** Spread into `OperationFooter`; the page adds its operation, templates, labels and help. */
        footer: {
            templatesDisabled: !!jsonError,
            startIsSuccess: startMutation.isSuccess,
            startIsPending: pending,
            onStart: () => startMutation.mutate(),
            onSchedule: () => scheduleMutation.mutate(),
            ...(dryRun
                ? {
                      dryRunIsPending: dryRunMutation.isPending,
                      onDryRun: () => dryRunMutation.mutate(),
                  }
                : {}),
            startBlocked: !!jsonError || !!reason,
            buttonText,
            buttonIcon,
            onResetPaths: resetPaths,
            onResetOptions: resetOptions,
            onResetAll: resetAll,
        },
    }
}
