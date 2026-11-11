import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Switch,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowsRotate as ArrowsRotateIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    MoreVerticalCircle as MoreVerticalCircleIcon,
    Pen as PenIcon,
    Repeat as RepeatIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { type ReactNode, useId } from 'react'
import type { Watchers } from '../../../lib/core/types'
import { timeAgo } from '../../../lib/format'
import { platform } from '../../../lib/shell'
import { openHistory } from '../../../lib/transfers'
import { ROW_LINE_1, ROW_LINE_2, RowStatus } from '../../components/list/ListWindow'
import { IconTile } from '../../components/look/IconTile'
import { WINDOWS } from '../../routes'
import { deletesCopy, firstLine, isInitializing, statusOf } from './status'

export interface RowActions {
    onPause: (paused: boolean) => void
    onSyncNow: () => void
    onEdit: () => void
    onResync: () => void
    onDelete: () => void
    onForce: () => void
}

const LOOK = WINDOWS.watchers

/**
 * One watcher, as a row of the list. Sync now and Edit show while the pointer or the focus is on
 * the row. When the watcher needs the user, or is failing, what happened shows under the row.
 */
export default function WatcherRow({
    watcher: w,
    now,
    actions,
}: {
    watcher: Watchers.Watcher
    now: number
    actions: RowActions
}) {
    const status = statusOf(w)
    const switchLabel = useId()
    const changed =
        w.lastChangeAt !== null && w.lastChangeId
            ? { id: w.lastChangeId, ago: timeAgo(w.lastChangeAt, Math.max(now, w.lastChangeAt)) }
            : null
    const name = w.name
    const pathA = w.pathA
    const pathB = w.pathB

    return (
        <div className="flex flex-col gap-2.5 py-3.5 pl-4 pr-3 group/row">
            <div className="flex items-center gap-3.5">
                <IconTile
                    icon={LOOK.icon}
                    tone={LOOK.tone}
                    size="lg"
                    className={cn(
                        'transition-[opacity,filter] duration-200 ease-out',
                        w.paused && 'opacity-40 grayscale'
                    )}
                />
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span
                        className={cn(
                            'font-semibold text-[15px]',
                            ROW_LINE_1,
                            w.paused && 'text-default-500'
                        )}
                    >
                        {w.name}
                    </span>
                    <span
                        className={cn('flex items-center gap-1.5 font-mono', ROW_LINE_2)}
                        title={`${pathA} ↔ ${pathB}`}
                    >
                        <span aria-hidden={true} className="contents">
                            <FolderPath path={pathA} />
                            <span className="font-sans shrink-0 text-default-400">↔</span>
                            <FolderPath path={pathB} />
                        </span>
                        <span className="sr-only">
                            {t({
                                message: `${pathA} and ${pathB}`,
                                comment: "A watcher's two folders, as a screen reader says them.",
                            })}
                        </span>
                    </span>
                </div>
                <RowStatus
                    kind={status.kind}
                    label={status.label}
                    when={
                        changed
                            ? lastChange(changed.ago)
                            : isInitializing(w)
                              ? t`Merging the folders`
                              : ''
                    }
                    onOpen={changed ? () => openHistory(changed.id) : undefined}
                    openTip={t`Open the last change in History`}
                />
                <div className="flex items-center gap-0.5 shrink-0">
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none">
                        <Tooltip content={t`Sync now`} color="foreground">
                            <span>
                                <Button
                                    isIconOnly={true}
                                    size="sm"
                                    variant="light"
                                    aria-label={t`Sync now`}
                                    isDisabled={!!w.attention}
                                    onPress={actions.onSyncNow}
                                    className="text-default-600"
                                >
                                    <ArrowsRotateIcon className="size-4" />
                                </Button>
                            </span>
                        </Tooltip>
                        <Tooltip content={t`Edit`} color="foreground">
                            <Button
                                isIconOnly={true}
                                size="sm"
                                variant="light"
                                aria-label={t`Edit ${name}`}
                                onPress={actions.onEdit}
                                className="text-default-600"
                            >
                                <PenIcon className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                    {/* HeroUI's Switch drops its aria-label when it has no text, so the
                    switch is named by a hidden label instead. */}
                    <span id={switchLabel} className="sr-only">
                        {w.paused ? t`Resume ${name}` : t`Pause ${name}`}
                    </span>
                    <Switch
                        size="sm"
                        isSelected={!w.paused}
                        onValueChange={(on) => actions.onPause(!on)}
                        aria-labelledby={switchLabel}
                        data-focus-visible="false"
                        classNames={{ base: 'mx-1.5', wrapper: 'me-0' }}
                    />
                    <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                        <DropdownTrigger>
                            <Button
                                isIconOnly={true}
                                size="sm"
                                variant="light"
                                aria-label={t`More for ${name}`}
                                className="text-default-600"
                            >
                                <MoreVerticalCircleIcon className="size-4" />
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label={t`Actions for ${name}`}
                            onAction={(key) => {
                                if (key === 'edit') actions.onEdit()
                                if (key === 'resync') actions.onResync()
                                if (key === 'delete') actions.onDelete()
                            }}
                        >
                            <DropdownItem key="edit" startContent={<PenIcon className="size-4" />}>
                                <Trans>Edit</Trans>
                            </DropdownItem>
                            <DropdownItem
                                key="resync"
                                startContent={<RepeatIcon className="size-4" />}
                            >
                                <Trans comment="Merges a watcher's two folders again, as its first sync did.">
                                    Resync
                                </Trans>
                            </DropdownItem>
                            <DropdownItem
                                key="delete"
                                color="danger"
                                className="text-danger"
                                startContent={<TrashIcon className="size-4" />}
                            >
                                <Trans>Delete</Trans>
                            </DropdownItem>
                        </DropdownMenu>
                    </Dropdown>
                </div>
            </div>
            <Trouble watcher={w} actions={actions} />
        </div>
    )
}

function lastChange(ago: string): string {
    return t({
        message: `Last change ${ago}`,
        comment: '{ago} is how long ago it was: "Last change 5 minutes ago".',
    })
}

/** What shows under a watcher that needs the user, or that is failing. */
function Trouble({ watcher: w, actions }: { watcher: Watchers.Watcher; actions: RowActions }) {
    // While a Resync runs, the watcher is initializing, and what it needed waits for the result.
    if (w.resyncing) return null
    if (w.attention === 'deletes' || w.attention === 'emptied') {
        const copy = deletesCopy(w)
        return (
            <Callout>
                <p className="leading-snug text-danger-700 dark:text-danger-400 text-pretty">
                    {copy.explanation}
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="flat" color="primary" onPress={actions.onResync}>
                        <Trans>Bring them back</Trans>
                    </Button>
                    <Button
                        size="sm"
                        color="danger"
                        variant="light"
                        className="max-w-full"
                        onPress={actions.onForce}
                    >
                        <span className="truncate">{copy.deleteLabel}</span>
                    </Button>
                </div>
            </Callout>
        )
    }
    if (w.attention) {
        return (
            <Callout>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p
                        className="flex-1 leading-snug break-words min-w-60 text-danger-700 dark:text-danger-400"
                        title={w.lastError}
                    >
                        {w.lastError}
                    </p>
                    <Button size="sm" color="danger" variant="flat" onPress={actions.onResync}>
                        <Trans comment="Merges a watcher's two folders again, as its first sync did.">
                            Resync
                        </Trans>
                    </Button>
                </div>
            </Callout>
        )
    }
    if (!w.paused && w.lastResult === 'failed' && w.lastError) {
        return (
            <Tooltip content={w.lastError} color="foreground" className="max-w-md" delay={300}>
                <p className="flex items-center gap-2 px-3 py-2 ml-[3.125rem] rounded-xl bg-warning/10 text-small text-warning-700 dark:text-warning-500">
                    <ExclamationTriangleIcon className="size-4 shrink-0" />
                    <span className="truncate">{firstLine(w.lastError)}</span>
                </p>
            </Tooltip>
        )
    }
    return null
}

const TRAILING_SLASHES = /[\\/]+$/

/**
 * A folder of a watcher, on one line. When it is too long, the middle is cut: the start keeps the
 * remote and the end keeps the folder's own name ("/Users/me/Docu…/Contracts").
 */
function FolderPath({ path }: { path: string }) {
    const trimmed = path.replace(TRAILING_SLASHES, '')
    const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (at <= 0) return <span className="min-w-0 truncate">{path}</span>
    return (
        <span className="flex min-w-0">
            <span className="truncate min-w-8">{path.slice(0, at)}</span>
            {/* The name doesn't shrink, so it isn't cut by a fraction of a pixel. A very long
            name still leaves the start a few letters. */}
            <span className="truncate shrink-0 max-w-[calc(100%-2rem)]">{path.slice(at)}</span>
        </span>
    )
}

function Callout({ children }: { children: ReactNode }) {
    return (
        <div className="flex gap-2.5 p-3 ml-[3.125rem] rounded-xl bg-danger/10 text-small">
            <ExclamationTriangleIcon className="size-4 mt-px shrink-0 text-danger-600 dark:text-danger-400" />
            <div className="flex flex-col flex-1 min-w-0 gap-2.5">{children}</div>
        </div>
    )
}
