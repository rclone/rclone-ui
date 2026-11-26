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

type Operation = OperationSubset<'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge'>

export interface StartPaths {
    sources?: string[]
    source?: string
    destination?: string
}

export type OperationArgs = Operations.CopyArgs & Operations.SyncArgs

export function startPathsProblem(
    paths: StartPaths,
    host: Host = currentHost()
): string | undefined {
    const sources = paths.sources ?? (paths.source ? [paths.source] : [])
    if (pathsProblem(sources, host)) return t`Fix the source path`
    if (pathsProblem([paths.destination], host)) return t`Fix the destination path`
    return undefined
}

const OPTIONS_FIELD = 'options.'

const NO_REFUSALS: Readonly<Record<string, string>> = {}

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

type Starts<Args, Started> =
    | {
          operation: Operation
          start?: undefined
          dryRun?: boolean
      }
    | {
          operation: 'mount' | 'serve' | 'download'
          start: (args: Args) => Promise<Started>
          dryRun?: undefined
      }

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
    problem: () => string | undefined
    paths?: (args: Args) => StartPaths
    jsonError?: string | null
    buildArgs: () => NoInfer<Args>
    confirm?: (args: Args) => Promise<StartAnswer>
    retry?: (failure: unknown, args: Args) => Promise<Args | false | undefined>
    error: { title: string; message: string; log: string[] } | ((failure: unknown) => Promise<void>)
    startLabel?: string
    pendingLabel?: string
    reset: { paths: () => void; extras?: () => void }
    groups?: {
        resetJson: () => void
    }
}) {
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

    const scheduling = useScheduling({
        operation,
        enabled: !startOwn,
        problem: problemOrPath,
        buildForm: () => formOf(operation as Operation, buildArgs() as OperationArgs),
        title: typeof error === 'function' ? WINDOWS[operation].title : error.title,
    })

    const transfer = (args: Args, preview?: boolean) => {
        const form = formOf(operation as Operation, args as OperationArgs)
        return startTransfer(form, { dryRun: preview, preset: form })
    }
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

    const command = async (): Promise<Operations.Script> => {
        guard()
        const args = buildArgs()
        const checked = checkedOf(operation, args) ?? {
            form: formOf(operation, args as ArgsOf<typeof operation>),
        }
        return scriptOf(checked)
    }

    const editing = scheduling.editing
    const pending = startState.pending || scheduling.saving
    const reason = problemOrPath()
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
            data: startState.started,
            reset: resetStart,
        },
        scheduling: scheduling.element,
        templatesDisabled: !!jsonError,
        command,
        preview:
            dryRun && !editing
                ? {
                      run: runDryRun,
                      isDisabled: startBlocked || pending || dryRunMutation.isPending,
                  }
                : undefined,
        refusals,
        footer: {
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
