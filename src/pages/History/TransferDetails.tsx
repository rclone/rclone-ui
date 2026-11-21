import { Button, Chip, cn, Skeleton, Spinner, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleDownSmall as AngleDownSmallIcon,
    AngleLeftSmall as AngleLeftSmallIcon,
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    Search as SearchIcon,
    SlidersSimple as SlidersSimpleIcon,
    Stop as StopIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useId, useMemo, useState } from 'react'
import type { Bus, Transfers } from '../../../lib/core/types'
import { coreError, formatErrorMessage } from '../../../lib/errors'
import { formatBytes, formatDate, formatNumber } from '../../../lib/format'
import { message } from '../../../lib/shell'
import {
    stopTransfer,
    useLiveNumbers,
    useRetryable,
    useTransfer,
    useTransferFiles,
} from '../../../lib/transfers'
import { openOperation } from '../../../lib/transfers/preset'
import { rerunEffect } from '../../../lib/transfers/retry'
import { ENDED, isLive, percent } from '../../../lib/transfers/rows'
import Alert from '../../components/Alert'
import EmptyState from '../../components/EmptyState'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { ToneProgress } from '../../components/look/ToneProgress'
import type { Tone } from '../../components/look/tones'
import { RouteLink, RoutePanel, RouteRow } from '../../components/PathFinder'
import { toastSuccess } from '../../components/toast'
import { WINDOWS, type WindowLook } from '../../routes'
import { bytesOf, formatWhen, operationLabel, originOf, standingOf, timingOf } from './describe'
import { ArrowRotateLeftIcon, lookOfOperation, ORIGINS, STANDING_KIND } from './rows'

/** The sections that group the files of a transfer. The first two exist only while it runs. */
type SectionKey = 'checking' | 'transferring' | 'transferred' | 'failed' | 'checked'

export function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
    return (
        <div className="flex items-center px-4 pt-3 shrink-0">
            <Button
                size="sm"
                variant="light"
                startContent={<AngleLeftSmallIcon className="size-4" />}
                onPress={onBack}
                className="text-default-600"
                data-focus-visible="false"
            >
                {label}
            </Button>
        </div>
    )
}

/**
 * The details of one transfer. The transfer is fetched again on transfers.changed, and its files
 * are loaded in pages for each outcome. While it runs, it also shows the files in progress and
 * the newest finished ones from transfers.progress.
 */
export default function TransferDetails({
    id,
    onBack,
    onSelect,
    onRetry,
}: {
    id: string
    onBack: () => void
    onSelect: (id: string) => void
    onRetry: () => void
}) {
    const { transfer: detail, query } = useTransfer(id)
    if (!detail) {
        if (query.isError) {
            return coreError(query.error)?.code === 'not_found' ? (
                <TransferNotFound onBack={onBack} />
            ) : (
                <>
                    <BackBar label={WINDOWS.history.title} onBack={onBack} />
                    <EmptyState
                        icon={WINDOWS.history.icon}
                        tone={WINDOWS.history.tone}
                        title={t`Couldn't load the transfer`}
                        description={formatErrorMessage(query.error)}
                        className="flex-1"
                        actions={
                            <Button
                                variant="flat"
                                isLoading={query.isFetching}
                                onPress={() => query.refetch()}
                                data-focus-visible="false"
                            >
                                <Trans>Retry</Trans>
                            </Button>
                        }
                    />
                </>
            )
        }
        return (
            <>
                <BackBar label={WINDOWS.history.title} onBack={onBack} />
                <DetailsSkeleton />
            </>
        )
    }
    return (
        <Details
            key={detail.transfer.id}
            detail={detail}
            onBack={onBack}
            onSelect={onSelect}
            onRetry={onRetry}
        />
    )
}

export function TransferNotFound({ onBack }: { onBack: () => void }) {
    return (
        <EmptyState
            icon={SearchIcon}
            tone={WINDOWS.history.tone}
            title={t`No such transfer`}
            description={t`It is not in the record, or the address is wrong.`}
            actions={
                <Button variant="flat" onPress={onBack} data-focus-visible="false">
                    <Trans>Back to History</Trans>
                </Button>
            }
        />
    )
}

function DetailsSkeleton() {
    return (
        <div aria-busy={true} aria-label={t`Loading`} className="flex flex-col gap-6 px-6 pt-3">
            <div className="flex items-center gap-4">
                <Skeleton className="size-16 rounded-[18px]" />
                <div className="flex flex-col gap-2.5">
                    <Skeleton className="w-40 h-6 rounded-md" />
                    <Skeleton className="w-64 h-3.5 rounded-md" />
                </div>
            </div>
            <Skeleton className="w-full h-24 rounded-2xl" />
            <Skeleton className="w-full h-20 rounded-2xl" />
        </div>
    )
}

/** A file in a section, either stored with the transfer or just reported by transfers.progress. */
interface ShownFile {
    name: string
    error?: string
    completedAt?: number
}

function mergeByName(live: ShownFile[], recorded: ShownFile[]): ShownFile[] {
    if (live.length === 0) return recorded
    const seen = new Set(live.map((file) => file.name))
    return [...live, ...recorded.filter((file) => !seen.has(file.name))]
}

export function GeneralErrors({ general }: { general: Transfers.GeneralError[] }) {
    if (general.length === 0) return null
    return (
        <Alert color="danger" variant="faded" hideIcon={true}>
            <ul className="flex flex-col gap-1">
                {general.map(({ subject, error }) => (
                    <li key={`${subject}\n${error}`} className="wrap-anywhere">
                        {subject ? (
                            <Trans comment="An error of a transfer, with what it is about: a remote or a path.">
                                <span className="font-medium">{subject}:</span> {error}
                            </Trans>
                        ) : (
                            error
                        )}
                    </li>
                ))}
            </ul>
        </Alert>
    )
}

/**
 * Shown instead of Retry when this version of the app can't retry a transfer, because its plan
 * no longer passes the checks.
 */
export function RetryRefused({ reason }: { reason: string }) {
    return (
        <Alert color="danger" variant="faded" title={t`This transfer can't be retried.`}>
            <span className="wrap-anywhere">{reason}</span>
        </Alert>
    )
}

/**
 * Where the transfer read from and where it wrote to, drawn as the operation's page draws them.
 * Bisync goes both ways, so both dots are filled.
 */
function Route({ transfer }: { transfer: Transfers.Transfer }) {
    const { tone } = lookOfOperation(transfer.operation)
    const both = transfer.operation === 'bisync'
    if (!transfer.destination) {
        return (
            <RoutePanel tone={tone} className="p-1.5">
                <RouteRow stop="single" tone={tone} compact={true}>
                    <Place
                        label={t({ message: 'Paths', comment: 'The paths that a transfer used.' })}
                        paths={transfer.sources}
                    />
                </RouteRow>
            </RoutePanel>
        )
    }
    return (
        <RoutePanel tone={tone} className="p-1.5">
            <RouteRow stop="from" tone={tone} filled={both} compact={true}>
                <Place
                    label={
                        both
                            ? t({
                                  message: 'Folder A',
                                  comment: "The first of a bisync's folders.",
                              })
                            : t({ message: 'From', comment: 'The source of a transfer.' })
                    }
                    paths={transfer.sources}
                />
            </RouteRow>
            <RouteLink tone={tone} buttons={false} compact={true} />
            <RouteRow stop="to" tone={tone} compact={true}>
                <Place
                    label={
                        both
                            ? t({
                                  message: 'Folder B',
                                  comment: "The second of a bisync's folders.",
                              })
                            : t({ message: 'To', comment: 'The destination of a transfer.' })
                    }
                    paths={[transfer.destination]}
                />
            </RouteRow>
        </RoutePanel>
    )
}

function Place({ label, paths }: { label: string; paths: readonly string[] }) {
    return (
        <div className="flex items-baseline gap-3 px-3 py-2 min-h-9">
            <span className="w-16 shrink-0 text-small text-default-500">{label}</span>
            <span className="flex flex-col min-w-0">
                {paths.map((path) => (
                    <span key={path} className="font-mono text-sm leading-5 wrap-anywhere">
                        {path}
                    </span>
                ))}
            </span>
        </div>
    )
}

/** One figure of the report: a number with its name above, and a line under it. */
interface Figure {
    label: string
    value: string
    sub?: string
    tone?: 'danger'
}

function Figures({
    transfer,
    live,
    counts,
    tone,
}: {
    transfer: Transfers.Transfer
    live: Bus.TransferProgress | null | undefined
    counts: { transferred: number; failed: number; checked: number }
    tone: Tone
}) {
    const timing = timingOf(transfer, live)
    const open = transfer.endedAt === null
    const bytes = live?.bytes ?? transfer.stats?.bytes ?? 0
    const total = live?.totalBytes ?? transfer.stats?.totalBytes ?? 0
    const figures: Figure[] = []
    const files = t({ message: 'Files', comment: 'Above how many files a transfer has moved.' })
    if (open) {
        figures.push({
            label: t({ message: 'Progress', comment: 'Above how far a transfer is: "42%".' }),
            value:
                transfer.state === 'queued'
                    ? t({ message: 'Queued', context: 'state of a transfer' })
                    : formatNumber(percent(bytes, total) / 100, { style: 'percent' }),
            sub: total > 0 ? bytesOf(bytes, total) : undefined,
        })
        figures.push({
            label: t({ message: 'Speed', comment: 'Above how fast a transfer moves: "4 MB/s".' }),
            value: `${formatBytes(live?.speed ?? 0)}/s`,
        })
        const all = live?.totalFiles ? formatNumber(live.totalFiles) : ''
        figures.push({
            label: files,
            value: formatNumber(counts.transferred),
            sub: all
                ? t({
                      message: `of ${all}`,
                      comment: 'Under the number of files moved so far: "of 1,200" files in all.',
                  })
                : undefined,
        })
    } else {
        figures.push({
            label: t({
                message: 'Moved',
                comment: 'Above how much data a transfer moved: "4 GB".',
            }),
            value: formatBytes(bytes),
        })
        figures.push({ label: files, value: formatNumber(counts.transferred) })
        figures.push({
            label: t({ message: 'Checked', context: 'files' }),
            value: formatNumber(counts.checked),
        })
    }
    if (counts.failed > 0 || !open) {
        figures.push({
            label: t({ message: 'Failed', context: 'files' }),
            value: formatNumber(counts.failed),
            tone: counts.failed > 0 ? 'danger' : undefined,
        })
    }
    const deletes = transfer.stats?.deletes ?? 0
    if (!open && deletes > 0) {
        figures.push({
            label: t({ message: 'Deleted', context: 'files' }),
            value: formatNumber(deletes),
        })
    }
    if (timing) figures.push({ label: timing.label, value: timing.value })

    return (
        <Panel className="flex flex-col overflow-hidden">
            {open && (
                <div className="px-4 pt-4 pb-1">
                    <ToneProgress
                        tone={tone}
                        label={t`Progress of the transfer`}
                        value={
                            transfer.state === 'queued' || total === 0
                                ? undefined
                                : percent(bytes, total) / 100
                        }
                        className="h-2"
                    />
                </div>
            )}
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))]">
                {figures.map((figure) => (
                    <div
                        key={figure.label}
                        className="flex flex-col gap-1 px-4 py-3.5 border-divider not-first:border-l"
                    >
                        <dt className="text-xs font-medium text-default-500">{figure.label}</dt>
                        <dd
                            className={cn(
                                'text-xl font-semibold leading-tight tracking-tight tabular-nums',
                                figure.tone === 'danger' && 'text-danger-600 dark:text-danger-500'
                            )}
                        >
                            {figure.value}
                        </dd>
                        {figure.sub && (
                            <dd className="text-xs text-default-500 tabular-nums">{figure.sub}</dd>
                        )}
                    </div>
                ))}
            </dl>
        </Panel>
    )
}

function whenOf(transfer: Transfers.Transfer): string {
    if (transfer.startedAt === null) {
        const when = formatWhen(transfer.createdAt)
        return t({
            message: `Queued ${when}`,
            comment: 'When a transfer was queued: "Queued Today 21:14", "Queued Mon 09:30".',
        })
    }
    const when = formatWhen(transfer.startedAt)
    return t({
        message: `Started ${when}`,
        comment: 'When a transfer started: "Started Today 21:14", "Started Mon 09:30".',
    })
}

function RetriedAs({ seq }: { seq: number }) {
    return <Trans>Retried as #{seq}</Trans>
}

/**
 * The labels of the buttons that open the operation's page with this transfer's settings: the
 * tooltip of Reuse settings, and the button of the interrupted notice. Each operation has its
 * own sentence, so that a language can say it its own way.
 */
function reuseLabels(operation: string): { tooltip: string; open: string } {
    switch (operation) {
        case 'copy':
            return { tooltip: t`Open Copy with these settings`, open: t`Open Copy` }
        case 'move':
            return { tooltip: t`Open Move with these settings`, open: t`Open Move` }
        case 'sync':
            return { tooltip: t`Open Sync with these settings`, open: t`Open Sync` }
        case 'bisync':
            return { tooltip: t`Open Bisync with these settings`, open: t`Open Bisync` }
        case 'delete':
            return { tooltip: t`Open Delete with these settings`, open: t`Open Delete` }
        case 'purge':
            return { tooltip: t`Open Purge with these settings`, open: t`Open Purge` }
        case 'download':
            return { tooltip: t`Open Download with these settings`, open: t`Open Download` }
        case 'mount':
            return { tooltip: t`Open Mount with these settings`, open: t`Open Mount` }
        case 'serve':
            return { tooltip: t`Open Serve with these settings`, open: t`Open Serve` }
        default:
            return {
                tooltip: t`Open the operation with these settings`,
                open: t`Open the operation`,
            }
    }
}

/** What an open transfer without files says while rclone lists them: "Preparing · 1,200 entries listed". */
function preparing(listed: number): string {
    const text = t({
        message: 'Preparing',
        comment: 'A transfer that is listing the files before it starts.',
    })
    if (listed === 0) return text
    const count = plural(listed, { one: '# entry listed', other: '# entries listed' })
    return [text, count].join(' · ')
}

/** How the transfer stands, as a dot and a word: running, queued, or how it ended. */
function standingKindOf(transfer: Transfers.Transfer): { kind: StatusKind; label: string } {
    const standing = standingOf(transfer)
    if (standing) return { kind: STANDING_KIND[transfer.state] ?? 'idle', label: standing.label }
    return {
        kind: 'active',
        label:
            transfer.state === 'queued'
                ? t({ message: 'Queued', context: 'state of a transfer' })
                : t({ message: 'Running', context: 'state of a transfer' }),
    }
}

function Hero({
    transfer,
    look,
    retryOf,
    onSelect,
    actions,
}: {
    transfer: Transfers.Transfer
    look: WindowLook
    retryOf: Transfers.Ref | null
    onSelect: (id: string) => void
    actions: ReactNode
}) {
    const { kind, label } = standingKindOf(transfer)
    const origin = originOf(transfer.origin)
    // The schedule or the agent's app that started it, by name.
    const named = origin === 'schedule' || origin === 'agent' ? ORIGINS[origin] : null
    const when = whenOf(transfer)
    const seq = retryOf?.seq
    return (
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <IconTile icon={look.icon} tone={look.tone} size="2xl" />
            <div className="flex flex-col flex-1 gap-1.5 min-w-60">
                <h1 className="text-2xl font-semibold leading-tight tracking-tight font-rounded">
                    {operationLabel(transfer.operation)}{' '}
                    <span className="font-medium tabular-nums text-default-400">
                        #{transfer.seq}
                    </span>
                </h1>
                <p className="flex flex-wrap items-center text-sm gap-x-2.5 gap-y-1 text-default-500 tabular-nums">
                    <span
                        className={cn(
                            'flex items-center gap-2 font-medium text-foreground',
                            kind === 'danger' && 'text-danger-600 dark:text-danger-500'
                        )}
                    >
                        <StatusDot kind={kind} />
                        {label}
                    </span>
                    <span aria-hidden={true} className="text-default-300">
                        ·
                    </span>
                    <span>{when}</span>
                    {named && (
                        <>
                            <span aria-hidden={true} className="text-default-300">
                                ·
                            </span>
                            <span className="flex items-center min-w-0 gap-1.5">
                                <named.icon className="size-4 shrink-0" />
                                <span className="wrap-anywhere">
                                    {transfer.origin.name || named.label}
                                </span>
                            </span>
                        </>
                    )}
                    {transfer.isDryRun && (
                        <Chip size="sm" variant="flat" color="warning" className="h-5">
                            <Trans comment="A transfer that only showed what it would do, without changing files.">
                                Dry run
                            </Trans>
                        </Chip>
                    )}
                    {retryOf && (
                        <Tooltip content={t`Open the transfer this one retries`} color="foreground">
                            <Chip
                                as="button"
                                size="sm"
                                variant="flat"
                                className="h-5 cursor-pointer"
                                onClick={() => onSelect(retryOf.id)}
                            >
                                <Trans>Retry of #{seq}</Trans>
                            </Chip>
                        </Tooltip>
                    )}
                </p>
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
    )
}

function Details({
    detail,
    onBack,
    onSelect,
    onRetry,
}: {
    detail: Transfers.Detail
    onBack: () => void
    onSelect: (id: string) => void
    onRetry: () => void
}) {
    const { transfer } = detail
    const look = lookOfOperation(transfer.operation)
    // This state lives here rather than in each section. A section can be empty for a moment
    // while the transfer runs, and when it comes back it should be open or closed as before.
    const [closed, setClosed] = useState<Set<SectionKey>>(new Set())
    const section = (key: SectionKey) => ({
        isOpen: !closed.has(key),
        onToggle: () =>
            setClosed((previous) => {
                const next = new Set(previous)
                if (!next.delete(key)) next.add(key)
                return next
            }),
    })

    const live = isLive(transfer.state)
    // How the transfer ended, once it has.
    const ended = ENDED[transfer.state]
    const open = transfer.endedAt === null
    // Whether a transfer that ended without completing can be retried. The core decides, in the
    // same way as for the retry view.
    const { retryable } = useRetryable(
        !open && transfer.state !== 'completed' ? transfer.id : undefined
    )
    const refused = retryable?.refused ?? ''
    const failures = detail.retryable
    const progress = useLiveNumbers()
    const numbers = live ? (progress[transfer.id] ?? transfer.live) : undefined

    // These are fetched again on transfers.changed. The core stores the end (or stop) of a
    // transfer together with its last files, so the files read after that are complete.
    const transferred = useTransferFiles(transfer.id, 'transferred')
    const failed = useTransferFiles(transfer.id, 'failed')
    const checked = useTransferFiles(transfer.id, 'checked')

    // The settings of the window that started this transfer. A watcher's run has none: it is
    // not a page's form.
    const preset = originOf(transfer.origin) === 'watcher' ? null : (detail.preset ?? null)
    const reuse = preset ? reuseLabels(preset.operation) : undefined

    const [stopping, setStopping] = useState(false)
    const stop = async () => {
        setStopping(true)
        try {
            // The core marks the transfer as stopped before it stops the job, so the job's
            // "context canceled" error is never taken as a failure.
            await stopTransfer(transfer.id)
            toastSuccess(t`Transfer stopped`)
        } catch (error) {
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Could not stop the transfer`,
                kind: 'error',
            })
        } finally {
            setStopping(false)
        }
    }

    // The finished files, grouped by how each one ended. The files in progress are shown only
    // while the transfer runs.
    const files = useMemo(() => {
        const newest = numbers?.transferred ?? []
        return {
            transferred: mergeByName(
                newest.filter((file) => !file.error),
                transferred.files
            ),
            failed: mergeByName(
                newest.filter((file) => !!file.error),
                failed.files
            ),
            checked: checked.files as ShownFile[],
        }
    }, [numbers, transferred.files, failed.files, checked.files])
    const transferring = numbers?.transferring ?? []
    const checking = numbers?.checking ?? []

    // The file counts. While the transfer runs, they come from rclone. After it ends, they are
    // the final totals. Only the newest 1 000 transferred and checked files are stored, so the
    // counts can be larger than the lists.
    const counts = {
        transferred: Math.max(
            files.transferred.length,
            transferred.total,
            numbers?.files ?? transfer.stats?.transfers ?? 0
        ),
        failed: Math.max(files.failed.length, failed.total),
        checked: Math.max(
            files.checked.length,
            checked.total,
            numbers?.checks ?? transfer.stats?.checks ?? 0
        ),
    }
    const isEmpty =
        checking.length +
            transferring.length +
            files.transferred.length +
            files.failed.length +
            files.checked.length ===
        0
    const isLoading =
        isEmpty &&
        (transferred.query.isLoading || failed.query.isLoading || checked.query.isLoading)

    const actions = (
        <>
            {!ended && (
                <Button
                    color="danger"
                    variant="flat"
                    aria-label={t`Stop transfer`}
                    isLoading={stopping}
                    startContent={
                        stopping ? undefined : <StopIcon variant="filled" className="size-4" />
                    }
                    onPress={stop}
                >
                    <Trans comment="Button: stops the running transfer.">Stop</Trans>
                </Button>
            )}
            {failures > 0 && !refused && (
                <Tooltip
                    content={t`Choose failed files to retry`}
                    placement="bottom"
                    color="foreground"
                >
                    <Button
                        variant="flat"
                        color="warning"
                        startContent={<ArrowRotateLeftIcon className="size-4" />}
                        onPress={onRetry}
                    >
                        <Trans comment="Button: pick the failed files to run again, with how many there are.">
                            Retry failed <span className="tabular-nums">· {failures}</span>
                        </Trans>
                    </Button>
                </Tooltip>
            )}
            {preset && reuse && (
                <Tooltip content={reuse.tooltip} placement="bottom" color="foreground">
                    <Button
                        variant="flat"
                        startContent={<SlidersSimpleIcon className="size-4" />}
                        onPress={() => openOperation(preset)}
                    >
                        <Trans>Reuse settings</Trans>
                    </Button>
                </Tooltip>
            )}
        </>
    )

    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
            <BackBar label={WINDOWS.history.title} onBack={onBack} />
            <div className="flex flex-col gap-5 px-6 pt-3 pb-10">
                <Hero
                    transfer={transfer}
                    look={look}
                    retryOf={detail.retryOf}
                    onSelect={onSelect}
                    actions={actions}
                />

                {detail.retries.length > 0 && (
                    <div className="flex flex-row flex-wrap items-center gap-2">
                        {detail.retries.map((retry) => (
                            <Chip
                                key={retry.id}
                                as="button"
                                size="sm"
                                variant="flat"
                                className="cursor-pointer"
                                color={
                                    retry.state === 'completed'
                                        ? 'success'
                                        : retry.state === 'running' || retry.state === 'queued'
                                          ? 'primary'
                                          : 'danger'
                                }
                                endContent={<ArrowUpRightSquareIcon className="w-3 h-3 mr-1" />}
                                onClick={() => onSelect(retry.id)}
                            >
                                <RetriedAs seq={retry.seq} />
                            </Chip>
                        ))}
                    </div>
                )}

                <GeneralErrors general={detail.general} />
                {refused && <RetryRefused reason={refused} />}

                {transfer.state === 'interrupted' && (
                    <Alert
                        color="warning"
                        variant="faded"
                        title={t`The app stopped while this was running.`}
                        endContent={
                            preset && reuse ? (
                                <Button
                                    size="sm"
                                    variant="flat"
                                    color="warning"
                                    className="shrink-0"
                                    onPress={() => openOperation(preset)}
                                >
                                    {reuse.open}
                                </Button>
                            ) : undefined
                        }
                    >
                        <Trans>Run it again to resume from here.</Trans>{' '}
                        {rerunEffect(transfer.operation)}
                    </Alert>
                )}

                {transfer.isDryRun && (
                    <Alert color="warning" variant="faded">
                        <Trans>
                            This is a dry-run operation. No files were actually transferred.
                        </Trans>
                    </Alert>
                )}

                <Figures transfer={transfer} live={numbers} counts={counts} tone={look.tone} />
                <Route transfer={transfer} />

                {/* Each section is shown only when it has files. Failures come before the
                    files that went well, since they are what needs a look. */}
                <div className="flex flex-col gap-6 pt-3">
                    {transferring.length > 0 && (
                        <Section
                            title={t({
                                message: 'Transferring',
                                comment: 'The files that are moving now.',
                            })}
                            count={transferring.length}
                            {...section('transferring')}
                        >
                            {transferring.map((item, itemIndex) => {
                                const size = formatBytes(item.size)
                                const bytes = formatBytes(item.bytes ?? 0)
                                const speed = formatBytes(item.speed ?? 0)
                                const name = item.name
                                return (
                                    <FileRow key={item.name || itemIndex} name={item.name}>
                                        <span className="w-24 text-xs text-right tabular-nums shrink-0 whitespace-nowrap text-default-500">
                                            {speed}/s
                                        </span>
                                        <Tooltip
                                            content={t`Transferred ${bytes} of ${size}`}
                                            color="foreground"
                                            placement="bottom"
                                        >
                                            <span className="w-40 shrink-0">
                                                <ToneProgress
                                                    tone={look.tone}
                                                    label={t`Progress of ${name}`}
                                                    value={item.pct / 100}
                                                />
                                            </span>
                                        </Tooltip>
                                    </FileRow>
                                )
                            })}
                        </Section>
                    )}

                    {checking.length > 0 && (
                        <Section
                            title={t({
                                message: 'Checking',
                                comment: 'The files that are being compared now.',
                            })}
                            count={checking.length}
                            description={t`Files are being verified before transfer. This can take a while for large directories.`}
                            {...section('checking')}
                        >
                            {checking.map((item, itemIndex) => (
                                <FileRow key={item.name || itemIndex} name={item.name} />
                            ))}
                        </Section>
                    )}

                    {files.failed.length > 0 && (
                        <Section
                            title={t({ message: 'Failed', context: 'files' })}
                            count={counts.failed}
                            danger={true}
                            {...section('failed')}
                            more={
                                <More
                                    shown={files.failed.length}
                                    count={counts.failed}
                                    hasOlder={!!failed.query.hasNextPage}
                                    loading={failed.query.isFetchingNextPage}
                                    onLoad={() => failed.query.fetchNextPage()}
                                />
                            }
                        >
                            {files.failed.map((item, itemIndex) => (
                                // Show rclone's full error, since this row is where users read it.
                                <li
                                    key={item.name || `item-${itemIndex}`}
                                    className="flex flex-col gap-0.5 px-4 py-2.5"
                                >
                                    <span className="text-sm truncate">{item.name}</span>
                                    <span
                                        className="text-xs line-clamp-2 text-danger-600 dark:text-danger-500 wrap-anywhere"
                                        title={item.error}
                                    >
                                        {item.error}
                                    </span>
                                </li>
                            ))}
                        </Section>
                    )}

                    {files.transferred.length > 0 && (
                        <Section
                            title={t({ message: 'Transferred', context: 'files' })}
                            count={counts.transferred}
                            {...section('transferred')}
                            more={
                                <More
                                    shown={files.transferred.length}
                                    count={counts.transferred}
                                    hasOlder={!!transferred.query.hasNextPage}
                                    loading={transferred.query.isFetchingNextPage}
                                    onLoad={() => transferred.query.fetchNextPage()}
                                />
                            }
                        >
                            <FileRows files={files.transferred} />
                        </Section>
                    )}

                    {files.checked.length > 0 && (
                        <Section
                            title={t({ message: 'Checked', context: 'files' })}
                            count={counts.checked}
                            {...section('checked')}
                            more={
                                <More
                                    shown={files.checked.length}
                                    count={counts.checked}
                                    hasOlder={!!checked.query.hasNextPage}
                                    loading={checked.query.isFetchingNextPage}
                                    onLoad={() => checked.query.fetchNextPage()}
                                />
                            }
                        >
                            <FileRows files={files.checked} />
                        </Section>
                    )}

                    {isLoading ? (
                        <Spinner />
                    ) : isEmpty ? (
                        <p className="px-1 text-sm text-default-500">
                            {open ? preparing(numbers?.listed ?? 0) : t`No files were transferred.`}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function FileRow({ name, children }: { name: string; children?: ReactNode }) {
    return (
        <li className="flex items-center justify-between gap-4 px-4 py-2.5">
            <span className="flex-1 min-w-0 text-sm truncate" title={name}>
                {name}
            </span>
            {children}
        </li>
    )
}

function FileRows({ files }: { files: ShownFile[] }) {
    return files.map((item, itemIndex) => (
        <FileRow key={item.name || `item-${itemIndex}`} name={item.name}>
            {item.completedAt ? (
                <span className="text-xs whitespace-nowrap text-default-500 tabular-nums">
                    {formatDate(item.completedAt)}
                </span>
            ) : null}
        </FileRow>
    ))
}

/**
 * The end of a section. While there are older pages of files, it offers to load the next one.
 * After the last page, it says how many of the files were kept, since only the newest 1 000 are
 * stored.
 */
function More({
    shown,
    count,
    hasOlder,
    loading,
    onLoad,
}: {
    shown: number
    count: number
    hasOlder: boolean
    loading: boolean
    onLoad: () => void
}) {
    if (hasOlder) {
        return (
            <div className="flex justify-center">
                <Button
                    size="sm"
                    variant="light"
                    isLoading={loading}
                    onPress={onLoad}
                    data-focus-visible="false"
                >
                    <Trans>Show more</Trans>
                </Button>
            </div>
        )
    }
    if (count > shown) {
        const total = formatNumber(count)
        return (
            <p className="px-1 text-xs text-default-500 tabular-nums">
                {t({
                    message: plural(shown, {
                        one: `The last # of ${total}.`,
                        other: `The last # of ${total}.`,
                    }),
                    comment:
                        'Under a list of files that keeps only the newest ones: "The last 1,000 of 3,500."',
                })}
            </p>
        )
    }
    return null
}

function Section({
    title,
    count,
    description,
    danger,
    isOpen,
    onToggle,
    more,
    children,
}: {
    title: string
    count: number
    description?: string
    danger?: boolean
    isOpen: boolean
    onToggle: () => void
    /** What goes under the panel: Show more, or how many were kept. */
    more?: ReactNode
    children: ReactNode
}) {
    const reduced = useReducedMotion()
    const panel = useId()
    return (
        <section aria-label={title} className="flex flex-col gap-2.5">
            <SectionTitle
                className="px-1"
                description={isOpen ? description : undefined}
                title={
                    <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={panel}
                        onClick={onToggle}
                        className="flex items-center w-full gap-2 text-left outline-none rounded-small focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        <span className={cn(danger && 'text-danger-600 dark:text-danger-500')}>
                            {title}
                        </span>
                        <span className="font-normal tabular-nums text-default-400">
                            {formatNumber(count)}
                        </span>
                        <AngleDownSmallIcon
                            className={cn(
                                'size-4 text-default-500 transition-transform duration-150 ease-out motion-reduce:transition-none',
                                !isOpen && '-rotate-90'
                            )}
                        />
                    </button>
                }
            />
            <AnimatePresence initial={false}>
                {isOpen && (
                    <motion.div
                        id={panel}
                        // Clipped only while it opens or closes, so the panel keeps its shadow.
                        initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                        animate={{
                            height: 'auto',
                            opacity: 1,
                            transitionEnd: { overflow: 'visible' },
                        }}
                        exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                        transition={
                            reduced ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.3 }
                        }
                        className="flex flex-col gap-2.5"
                    >
                        <Panel>
                            <ul className="flex flex-col divide-y divide-divider">{children}</ul>
                        </Panel>
                        {more}
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    )
}
