import { Button, Chip, cn, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleRightSmall as AngleRightSmallIcon,
    ArchiveBox as ArchiveBoxIcon,
    ArrowRotateRight as ArrowRotateRightIcon,
    Clock as ClockIcon,
    DiagramTree as DiagramTreeIcon,
    FloppyDisk as FloppyDiskIcon,
    FolderConnection as FolderConnectionIcon,
    LayerGroup as LayerGroupIcon,
    Page as PageIcon,
    PenLine as PenLineIcon,
    SparklesAi as SparklesAiIcon,
} from '@zappicon/react'
import { memo } from 'react'
import type * as Core from '../../../lib/core/types'
import { formatBytes, formatDate, formatNumber } from '../../../lib/format'
import { percent } from '../../../lib/transfers/rows'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { ToneProgress } from '../../components/look/ToneProgress'
import { WINDOWS, type WindowLook } from '../../routes'
import {
    clockOf,
    type NamedOrigin,
    operationLabel,
    originOf,
    pathsOf,
    standingOf,
    statusOf,
} from './describe'

type Transfer = Core.Transfers.Transfer
type Icon = typeof PageIcon

/** Zappicon has no arrow that turns left, so the one that turns right is mirrored. */
export function ArrowRotateLeftIcon({ className }: { className?: string }) {
    return <ArrowRotateRightIcon className={cn('-scale-x-100', className)} />
}

/**
 * The look of a recorded operation: its window's tile when it has a window (Sync's green), and a
 * tile of its own for the Commander's small operations.
 */
export function lookOfOperation(operation: string): WindowLook {
    switch (operation) {
        case 'copy':
        case 'move':
        case 'sync':
        case 'bisync':
        case 'delete':
        case 'purge':
        case 'download':
            return WINDOWS[operation]
        case 'delete-folder':
            return { ...WINDOWS.delete, title: operationLabel(operation) }
        case 'cleanup':
            return { title: operationLabel(operation), icon: ArchiveBoxIcon, tone: 'graphite' }
        case 'save':
            return { title: operationLabel(operation), icon: FloppyDiskIcon, tone: 'blue' }
        case 'rename':
            return { title: operationLabel(operation), icon: PenLineIcon, tone: 'graphite' }
        default:
            return { title: operationLabel(operation), icon: PageIcon, tone: 'graphite' }
    }
}

export const ORIGINS: Record<NamedOrigin, { label: string; icon: Icon }> = {
    schedule: {
        label: t({
            message: 'Schedule',
            context: 'where a transfer was started from',
            comment: 'A noun: the schedule that started the transfer.',
        }),
        icon: ClockIcon,
    },
    template: {
        label: t({ message: 'Template', comment: 'A noun: a saved set of paths and options.' }),
        icon: LayerGroupIcon,
    },
    commander: { label: WINDOWS.commander.title, icon: DiagramTreeIcon },
    watcher: {
        label: t({ message: 'Watcher', comment: 'A noun: a watcher runs a transfer on a change.' }),
        icon: FolderConnectionIcon,
    },
    agent: {
        label: t({
            message: 'Agent',
            comment: 'A noun: the AI agent, such as Claude Code, that started the transfer.',
        }),
        icon: SparklesAiIcon,
    },
}

export type Row = Transfer & {
    isActive: boolean
    bytes: number
    totalBytes: number
    speed: number
    progress: number
    status: string
}

export function toRow(transfer: Transfer, live: Core.Bus.TransferProgress | null | undefined): Row {
    // While a transfer runs, its numbers come from the latest progress update. Once it has
    // ended, they come from its stored stats.
    const numbers = transfer.state === 'running' ? live : undefined
    const bytes = numbers?.bytes ?? transfer.stats?.bytes ?? 0
    const totalBytes = numbers?.totalBytes ?? transfer.stats?.totalBytes ?? 0
    return {
        ...transfer,
        isActive: transfer.endedAt === null,
        bytes,
        totalBytes,
        speed: numbers?.speed ?? 0,
        // A completed transfer shows 100%, even when everything was already there and nothing
        // moved.
        progress: transfer.state === 'completed' ? 100 : percent(bytes, totalBytes),
        status: statusOf(transfer, numbers),
    }
}

export const STANDING_KIND: Record<string, StatusKind> = {
    completed: 'success',
    failed: 'danger',
    stopped: 'idle',
    interrupted: 'warning',
}

function Paths({ row }: { row: Row }) {
    const { from, to, arrow, full } = pathsOf(row)
    if (!to) {
        return (
            <span className="truncate text-default-500" title={full}>
                {from}
            </span>
        )
    }
    return (
        <span className="truncate text-default-500" title={full}>
            <span aria-hidden={true}>
                {from}
                <span className="mx-1.5 text-default-400">{arrow}</span>
                {to}
            </span>
            <span className="sr-only">
                {t({
                    message: `${from} to ${to}`,
                    comment: 'The paths of a transfer, read aloud: "Photos to gdrive:Photos".',
                })}
            </span>
        </span>
    )
}

/**
 * Where a transfer came from, when `originOf` names it. A schedule, a template or a watcher shows
 * its label and its name. An agent shows its app's name alone ("Claude Code"), or "Agent" when
 * its app gave none.
 */
function Origin({ row }: { row: Row }) {
    const key = originOf(row.origin)
    if (!key) return null
    const origin = ORIGINS[key]
    const name = row.origin.name
    return (
        <span className={cn('flex items-center min-w-0 gap-1', name ? 'max-w-[45%]' : 'shrink-0')}>
            <origin.icon className="size-3.5 shrink-0" />
            {key === 'agent' && name ? (
                <span className="truncate" title={name}>
                    {name}
                </span>
            ) : (
                <>
                    <span className="shrink-0">{origin.label}</span>
                    {name && (
                        <span className="truncate" title={name}>
                            · {name}
                        </span>
                    )}
                </>
            )}
        </span>
    )
}

function DryRun() {
    return (
        <Chip size="sm" variant="flat" color="warning" className="h-5 shrink-0">
            <Trans comment="A transfer that only showed what it would do, without changing files.">
                Dry run
            </Trans>
        </Chip>
    )
}

export const RunningCard = memo(function RunningCard({
    row,
    onSelect,
}: {
    row: Row
    onSelect: (id: string) => void
}) {
    const look = lookOfOperation(row.operation)
    const queued = row.state === 'queued'
    const seq = row.seq
    return (
        <button
            type="button"
            onClick={() => onSelect(row.id)}
            className={cn(
                SURFACE,
                SURFACE_HOVER,
                'flex flex-col w-full gap-3 p-4 text-left outline-none',
                'transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.99]',
                'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                'focus-visible:ring-2 focus-visible:ring-primary'
            )}
        >
            <span className="flex items-center w-full gap-3.5">
                <IconTile icon={look.icon} tone={look.tone} size="lg" />
                <span className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span className="flex items-baseline min-w-0 gap-2 text-sm">
                        <span className="font-semibold shrink-0 text-[15px]">
                            {operationLabel(row.operation)}
                        </span>
                        <Paths row={row} />
                    </span>
                    <span className="flex items-center min-w-0 text-xs gap-x-2 text-default-500">
                        <span className="font-medium tabular-nums shrink-0">#{row.seq}</span>
                        <Origin row={row} />
                        {row.isDryRun && <DryRun />}
                        {row.status && <span className="truncate tabular-nums">{row.status}</span>}
                    </span>
                </span>
                <span className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className="text-lg font-semibold leading-none tabular-nums">
                        {queued
                            ? t({ message: 'Queued', context: 'state of a transfer' })
                            : row.totalBytes > 0
                              ? formatNumber(row.progress / 100, { style: 'percent' })
                              : null}
                    </span>
                    {!queued && row.speed > 0 && (
                        <span className="text-xs tabular-nums text-default-500">
                            {formatBytes(row.speed)}/s
                        </span>
                    )}
                </span>
                <AngleRightSmallIcon className="size-5 shrink-0 text-default-400" />
            </span>
            <ToneProgress
                tone={look.tone}
                label={t`Progress of #${seq}`}
                value={queued || row.totalBytes === 0 ? undefined : row.progress / 100}
            />
        </button>
    )
})

export const EndedRow = memo(function EndedRow({
    row,
    onSelect,
    onRetry,
}: {
    row: Row
    onSelect: (id: string) => void
    onRetry: (id: string) => void
}) {
    const look = lookOfOperation(row.operation)
    const failed = row.state === 'failed'
    const standing = standingOf(row)
    const at = row.endedAt ?? row.createdAt
    const seq = row.seq
    return (
        <div className="relative flex items-center gap-3.5 py-3 pl-4 pr-3 group/row transition-colors duration-150 ease-out hover:bg-default-100/50 has-[[data-row]:focus-visible]:bg-default-100/50">
            <IconTile icon={look.icon} tone={look.tone} size="md" />
            <span className="flex flex-col flex-1 min-w-0 gap-0.5">
                <span className="flex items-baseline min-w-0 gap-2 text-sm">
                    {/* The operation's name covers the row: it opens the details. */}
                    <button
                        type="button"
                        data-row={true}
                        onClick={() => onSelect(row.id)}
                        className="font-semibold text-left outline-none shrink-0 after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary"
                    >
                        {operationLabel(row.operation)}
                        <span className="sr-only"> #{row.seq}</span>
                    </button>
                    <Paths row={row} />
                </span>
                <span className="flex items-center min-w-0 text-xs gap-x-2 text-default-500">
                    <span className="font-medium tabular-nums shrink-0">#{row.seq}</span>
                    <Origin row={row} />
                    {row.isDryRun && <DryRun />}
                    {row.status && (
                        <span
                            className={cn(
                                'truncate tabular-nums',
                                failed && 'text-danger-600 dark:text-danger-500'
                            )}
                            title={failed && row.error ? row.error : undefined}
                        >
                            {row.status}
                        </span>
                    )}
                </span>
            </span>
            {failed && (
                <Tooltip content={t`Choose failed files to retry`} color="foreground" delay={300}>
                    <Button
                        size="sm"
                        variant="flat"
                        startContent={<ArrowRotateLeftIcon className="size-3.5" />}
                        onPress={() => onRetry(row.id)}
                        aria-label={t`Retry the failures of #${seq}`}
                        className="relative z-10 opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none"
                    >
                        <Trans>Retry</Trans>
                    </Button>
                </Tooltip>
            )}
            {standing && (
                <span
                    className={cn(
                        // At least the width of the usual labels, so the column lines up, and
                        // wider for a long one ("Stopped at 40%") rather than cutting it.
                        'flex items-center gap-2 text-sm font-medium min-w-32 whitespace-nowrap shrink-0',
                        failed && 'text-danger-600 dark:text-danger-500'
                    )}
                >
                    <StatusDot kind={STANDING_KIND[row.state] ?? 'idle'} />
                    <span>{standing.label}</span>
                </span>
            )}
            <time
                dateTime={new Date(at).toISOString()}
                title={formatDate(at)}
                className="min-w-12 text-xs text-right whitespace-nowrap text-default-500 tabular-nums shrink-0"
            >
                {clockOf(at)}
            </time>
            <AngleRightSmallIcon className="size-5 shrink-0 text-default-400" />
        </div>
    )
})
