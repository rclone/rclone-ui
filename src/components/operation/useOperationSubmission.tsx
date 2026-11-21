import { t } from '@lingui/core/macro'
import { Play as PlayIcon } from '@zappicon/react'
import { type ReactNode, startTransition, useCallback, useMemo, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import { coreError, formatErrorMessage, reportError } from '../../../lib/errors'
import { type ArgsOf, formOf, type OperationSubset } from '../../../lib/operations'
import { currentHost, type Host, pathsProblem } from '../../../lib/paths'
import { message } from '../../../lib/shell'
import { openHistory, startTransfer } from '../../../lib/transfers'
import { WINDOWS } from '../../routes'
import { useScheduling } from '../schedule/useScheduling'
import { fixOptionsText, invalidJsonText } from './optionGroups'
import { type CheckedForm, scriptOf, useFormRefusal } from './useFormRefusal'
import { useOperationDryRun } from './useOperationDryRun'

/** The operations that have a transfer page. */
type Operation = OperationSubset<'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge'>

export interface StartPaths {
    sources?: string[]
    source?: string
    destination?: string
}

/**
 * The arguments of a transfer page: the form fields from core/operations, the paths and the
 * option groups. Each operation's form reads only the fields it has.
 */
export type OperationArgs = Operations.CopyArgs & Operations.SyncArgs

/**
 * Returns the button text to show when a path can't be sent as it is, or undefined. A path has a
 * problem (see `pathsProblem`) when rclone would refuse it or read it differently than intended.
 * The field itself shows the details.
 */
export function startPathsProblem(
    paths: StartPaths,
    host: Host = currentHost()
): string | undefined {
    const sources = paths.sources ?? (paths.source ? [paths.source] : [])
    if (pathsProblem(sources, host)) return t`Fix the source path`
    if (pathsProblem([paths.destination], host)) return t`Fix the destination path`
    return undefined
}

/** The start of the field of a refused option group, such as `options.config`. */
const OPTIONS_FIELD = 'options.'

const NO_REFUSALS: Readonly<Record<string, string>> = {}

/**
 * The form that the core checks for a page (useFormRefusal). Download has none: it checks its
 * own fields, because the name that it suggests arrives after the URL is looked up.
 */
function checkedOf(
    operation: Operation | 'mount' | 'serve' | 'download',
    args: unknown
): CheckedForm | undefined {
    if (operation === 'mount') return { mount: args as Operations.MountArgs }
    if (operation === 'serve') return { serve: args as Operations.ServeArgs }
    if (operation === 'download') return undefined
    return { form: formOf(operation, args as ArgsOf<typeof operation>) }
}

function defaultStartLabel(operation: Operation | 'mount' | 'serve' | 'download'): string {
    switch (operation) {
        case 'copy':
            return t`Start copy`
        case 'move':
            return t`Start move`
        case 'sync':
            return t`Start sync`
        case 'bisync':
            return t`Start bisync`
        case 'delete':
            return t`Start delete`
        case 'purge':
            return t`Start purge`
        case 'mount':
            return t`Start mount`
        case 'serve':
            return t`Start serve`
        default:
            return t`Start download`
    }
}

export type StartAnswer = 'start' | 'dryRun' | 'cancel'

/**
 * How a page starts its operation. A transfer page starts a transfer: the core builds rclone's
 * request from the arguments, records the transfer and returns its id. A transfer page may also
 * offer a preview (a dry run). Mount, Serve and Download pass their own `start`, which returns
 * what was started (the mount, the serve, or the download's id).
 */
type Starts<Args, Started> =
    | {
          operation: Operation
          start?: undefined
          /** Whether the page offers a preview (a dry run). */
          dryRun?: boolean
      }
    | {
          operation: 'mount' | 'serve' | 'download'
          start: (args: Args) => Promise<Started>
          dryRun?: undefined
      }

/**
 * The start logic shared by the operation pages. Each page keeps its own paths, option groups and
 * JSX. This hook provides one guard for every action (`problem`, then the path check), the
 * question before the start (`confirm`), the start itself (see `Starts`), the optional dry run,
 * the button's text and icon, the problem that the action bar shows while the button is
 * disabled, and the three resets. The six transfer pages (Copy, Move, Sync, Bisync, Delete,
 * Purge), Mount and Serve spread `footer` into their `OperationFooter`. Download has its own
 * footer and uses only the parts it needs.
 */
export function useOperationSubmission<Args extends StartPaths = OperationArgs, Started = string>({
    operation,
    start: startOwn,
    dryRun = false,
    problem,
    paths,
    jsonError,
    buildArgs,
    confirm,
    retry,
    error,
    startLabel = defaultStartLabel(operation),
    pendingLabel = t`Starting…`,
    reset,
    groups,
}: Starts<Args, Started> & {
    /**
     * Why the operation can't start yet, or undefined. Shown in the action bar, and used for the
     * button's disabled state and every action's guard. The page passes translated text here, as
     * it does for `error`'s title and message and for the two labels.
     */
    problem: () => string | undefined
    /**
     * The paths to check, when they differ from the paths in the arguments (for example, Mount's
     * mount point when it is a drive letter).
     */
    paths?: (args: Args) => StartPaths
    /** The option group whose JSON can't be parsed, on pages that have option groups. */
    jsonError?: string | null
    /**
     * Builds the start's arguments. Their type is the one the start expects (OperationArgs for a
     * transfer).
     */
    buildArgs: () => NoInfer<Args>
    /**
     * Asks a question before the start, about what will be deleted (Sync, Delete, Purge). When
     * it is left out, nothing is asked.
     */
    confirm?: (args: Args) => Promise<StartAnswer>
    /**
     * Lets the page retry a failed start in another way (Bisync's first run, as a resync). It
     * returns the arguments to retry with, false when the page has already handled the failure
     * (the user declined its question), or undefined to report the failure.
     */
    retry?: (failure: unknown, args: Args) => Promise<Args | false | undefined>
    /** How a failed start is reported: in a dialog with this text, or by the page's function. */
    error: { title: string; message: string; log: string[] } | ((failure: unknown) => Promise<void>)
    /** The button's text. Defaults to the operation's own "Start copy" (defaultStartLabel). */
    startLabel?: string
    pendingLabel?: string
    reset: { paths: () => void; extras?: () => void }
    groups?: {
        resetJson: () => void
    }
}) {
    // Check the page's own reasons first (a missing path, two identical paths), then the paths
    // themselves. A path that rclone would refuse or misread is never sent.
    const problemOrPath = () => {
        const reason = problem()
        if (reason) return reason
        const args = buildArgs()
        return startPathsProblem(paths ? paths(args) : args)
    }
    const guard = () => {
        const reason = problemOrPath()
        if (reason) throw new Error(reason)
    }

    // The Schedule button, and the edit mode in which Start saves the form into a schedule.
    const scheduling = useScheduling({
        operation,
        enabled: !startOwn,
        problem: problemOrPath,
        buildForm: () => formOf(operation as Operation, buildArgs() as OperationArgs),
        title: typeof error === 'function' ? WINDOWS[operation].title : error.title,
    })

    // Starts or previews a transfer on a transfer page. The other pages have no dry run and pass
    // their own start.
    const transfer = (args: Args, preview?: boolean) => {
        const form = formOf(operation as Operation, args as OperationArgs)
        return startTransfer(form, { dryRun: preview, preset: form })
    }
    // A transfer returns its id, which is what Started is when the page has no start of its own.
    const begin = startOwn ?? ((args: Args) => transfer(args) as Promise<Started>)

    const [startState, setStartState] = useState<{ pending: boolean; started?: Started }>({
        pending: false,
    })
    const [started, setStarted] = useState(false)
    const resetStart = useCallback(() => {
        setStarted(false)
        setStartState({ pending: false })
    }, [])

    const dryRunMutation = useOperationDryRun(async () => {
        guard()
        return transfer(buildArgs(), true)
    })
    // The mutation's onError already reports the failure.
    const runDryRun = () => dryRunMutation.mutateAsync().catch(() => {})

    const startWith = async (args: Args) => {
        const answer = await begin(args)
        setStartState({ pending: false, started: answer })
        setStarted(true)
    }

    const reportFailure = async (failure: unknown) => {
        if (typeof error === 'function') {
            await error(failure)
            return
        }
        // The transfer was recorded before it failed (its job ended within a second), so it is
        // listed in History, where it can be retried.
        const recorded = coreError(failure)?.transfer?.id
        if (recorded) {
            const show = t`Show transfer`
            const pressed = await message(formatErrorMessage(failure, error.message), {
                title: error.title,
                kind: 'error',
                buttons: { ok: show, cancel: t`Close` },
            })
            if (pressed === show) await openHistory(recorded)
            return
        }
        await reportError(failure, {
            title: error.title,
            fallback: error.message,
            log: error.log,
        })
    }

    const start = async () => {
        // Ask the question first, so the button only shows STARTING after it is answered.
        if (confirm) {
            let answer: StartAnswer
            try {
                guard()
                answer = await confirm(buildArgs())
            } catch (failure) {
                await reportFailure(failure)
                return
            }
            if (answer === 'dryRun') return runDryRun()
            if (answer !== 'start') return
        }
        setStartState({ pending: true })
        let args: Args | undefined
        try {
            guard()
            args = buildArgs()
            await startWith(args)
        } catch (failure) {
            setStartState({ pending: false })
            const again = args && retry ? await retry(failure, args) : undefined
            if (again === false) return
            if (!again) {
                await reportFailure(failure)
                return
            }
            setStartState({ pending: true })
            try {
                await startWith(again)
            } catch (second) {
                setStartState({ pending: false })
                await reportFailure(second)
            }
        }
    }

    // The page's operation as rclone commands and as a program for rclone-sdk (CommandModal). A
    // page that can't start says why instead, as it does for a start.
    const command = async (): Promise<Operations.Script> => {
        guard()
        const args = buildArgs()
        // The core doesn't check a download's form, but it writes its command.
        const checked = checkedOf(operation, args) ?? {
            form: formOf(operation, args as ArgsOf<typeof operation>),
        }
        return scriptOf(checked)
    }

    const editing = scheduling.editing
    const pending = startState.pending || scheduling.saving
    const reason = problemOrPath()
    // Once the page's own checks pass, the core checks the form as its start would, and says
    // what it would refuse: an option that a transfer can't set, a metadata mapper without
    // metadata, the root of a remote for a delete. A refused option shows under its group's
    // editor (refusals), and the bar names the group.
    const refusal = useFormRefusal(
        reason || jsonError ? undefined : checkedOf(operation, buildArgs())
    )
    const refusedGroup = refusal?.field?.startsWith(OPTIONS_FIELD)
        ? refusal.field.slice(OPTIONS_FIELD.length)
        : undefined
    const refusals = useMemo<Readonly<Record<string, string>>>(
        () => (refusedGroup && refusal ? { [refusedGroup]: refusal.message } : NO_REFUSALS),
        [refusedGroup, refusal]
    )
    const refusalText = refusal
        ? ((refusedGroup && fixOptionsText(refusedGroup)) ?? refusal.message)
        : undefined
    const startBlocked = !!jsonError || !!reason || !!refusal || (editing && !scheduling.ready)
    // The bar says why the button is disabled, and the button keeps saying what it does.
    const problemText = reason ?? (jsonError ? invalidJsonText(jsonError) : refusalText)
    const buttonText = useMemo(() => {
        if (pending) return editing ? t`Saving…` : pendingLabel
        return editing ? t`Save changes` : startLabel
    }, [pending, startLabel, pendingLabel, editing])
    const buttonIcon = useMemo<ReactNode>(() => {
        if (pending || problemText || editing) return undefined
        return <PlayIcon variant="filled" className="size-4" />
    }, [pending, problemText, editing])

    const resetPaths = () =>
        startTransition(() => {
            reset.paths()
            resetStart()
        })
    const resetOptions = () =>
        startTransition(() => {
            groups?.resetJson()
            reset.extras?.()
            resetStart()
        })
    const resetAll = () =>
        startTransition(() => {
            groups?.resetJson()
            reset.extras?.()
            reset.paths()
            resetStart()
        })

    return {
        startMutation: {
            isPending: pending,
            isSuccess: started,
            /** What the start returned: a transfer's id, or what the page's own start returned. */
            data: startState.started,
            reset: resetStart,
        },
        /**
         * The Schedule drawer, or the bar of the edit mode ("Editing the schedule …"). The page
         * shows it at the top of its form.
         */
        scheduling: scheduling.element,
        /** Whether the Templates menu is disabled: bad JSON in a group would be saved or merged. */
        templatesDisabled: !!jsonError,
        /** The page's operation for a script, for `OperationHeader`'s Copy command. */
        command,
        /**
         * The preview (a dry run), for `OperationHeader`'s More menu. Only set on the pages that
         * offer one (Copy, Move, Sync and Delete), and not while a schedule is edited.
         */
        preview:
            dryRun && !editing
                ? {
                      run: runDryRun,
                      isDisabled: startBlocked || pending || dryRunMutation.isPending,
                  }
                : undefined,
        /**
         * The core's refusal of an option group's options, by the group's key (`config`), for
         * that group's editor. It holds one group at most.
         */
        refusals,
        /** Spread into `OperationFooter`. The page adds its lines and labels. */
        footer: {
            // In edit mode, Start saves the schedule and stays Save changes.
            startIsSuccess: started && !editing,
            startIsPending: pending,
            previewIsPending: dryRunMutation.isPending,
            onStart: editing ? scheduling.saveChanges : start,
            onSchedule: scheduling.schedulable ? scheduling.openDrawer : undefined,
            startBlocked,
            problem: problemText,
            buttonText,
            buttonIcon,
            onResetPaths: resetPaths,
            onResetOptions: resetOptions,
            onResetAll: resetAll,
        },
    }
}
