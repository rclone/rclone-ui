import { Button, Chip, cn, ScrollShadow, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleDownSmall as AngleDownSmallIcon,
    AngleUpSmall as AngleUpSmallIcon,
    ArrowsRotate as ArrowsRotateIcon,
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    Check as CheckIcon,
    Pen as PenIcon,
    Repeat as RepeatIcon,
    Search as SearchIcon,
    Xmark as XmarkIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ComponentType, type ReactNode, useCallback, useEffect, useState } from 'react'
import { formatBytes, formatNumber } from '../../../lib/format'
import { usePref, usePrefsLoaded } from '../../../lib/prefs'
import { ask } from '../../../lib/shell'
import { openHistory, useLiveNumbers, useTracked } from '../../../lib/transfers'
import { splitFiles } from '../../../lib/transfers/details'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE } from '../../components/look/Panel'
import { StatusDot } from '../../components/look/Status'
import { ToneProgress } from '../../components/look/ToneProgress'
import { TIP } from '../../components/look/tip'
import type { Tone } from '../../components/look/tones'
import { onTransferEnd, PlacesMenu } from '../../components/navigator'

// The tooltip says why the button is disabled, and the wrapping div keeps it working while the
// button is disabled.
function BarAction({
    label,
    icon: Icon,
    count,
    disabledReason,
    onPress,
}: {
    label: string
    icon: ComponentType<{ className?: string }>
    count?: number
    disabledReason?: string
    onPress: () => void
}) {
    return (
        <Tooltip content={disabledReason ?? label} {...TIP} closeDelay={0}>
            <div onClick={(e) => e.stopPropagation()}>
                <Button
                    size="sm"
                    variant="light"
                    radius="md"
                    aria-label={label}
                    isDisabled={!!disabledReason}
                    onPress={onPress}
                    startContent={<Icon className="size-4 shrink-0" />}
                    className="gap-1.5 px-2 min-w-0 text-[13px] text-default-700 data-[disabled=true]:opacity-45"
                >
                    <span className="hidden lg:inline">{label}</span>
                    {count !== undefined && count > 0 && !disabledReason && (
                        <span className="px-1.5 rounded-full bg-primary/15 text-primary text-[11px] font-semibold tabular-nums">
                            {formatNumber(count)}
                        </span>
                    )}
                </Button>
            </div>
        </Tooltip>
    )
}

function timeLeft(seconds: number): string {
    if (seconds < 60) {
        const s = formatNumber(Math.max(1, Math.round(seconds)))
        return t({
            message: `${s} s left`,
            comment: 'The time a transfer still needs, in seconds.',
        })
    }
    const total = Math.round(seconds / 60)
    if (total < 60) {
        const min = formatNumber(total)
        return t({
            message: `${min} min left`,
            comment: 'The time a transfer still needs, in minutes.',
        })
    }
    const h = formatNumber(Math.floor(total / 60))
    const min = formatNumber(total % 60)
    return t({
        message: `${h} h ${min} min left`,
        comment: 'The time a transfer still needs, in hours and minutes.',
    })
}

function speedWords(bytesPerSecond: number): string {
    const size = formatBytes(bytesPerSecond)
    return t({ message: `${size}/s`, comment: 'A transfer speed: "1.5 MB/s".' })
}

function partWords(bytes: number, total: number): string {
    const done = formatBytes(bytes)
    const size = formatBytes(total)
    return t({
        message: `${done} of ${size}`,
        comment: 'How much is transferred: "12 MB of 40 MB".',
    })
}

const ACTIVITY_TIP = 'commanderActivityTip'

function useActivityTipSeen(): [boolean, () => void] {
    const loaded = usePrefsLoaded()
    const [acknowledged, setAcknowledged] = usePref('acknowledgements')
    const due = loaded && !acknowledged.includes(ACTIVITY_TIP)
    const markSeen = useCallback(() => {
        if (acknowledged.includes(ACTIVITY_TIP)) return
        setAcknowledged([...acknowledged, ACTIVITY_TIP]).catch((error: unknown) =>
            console.warn('could not save the activity tip as seen', error)
        )
    }, [acknowledged, setAcknowledged])
    return [due, markSeen]
}

export function useActivityTip(isExpanded: boolean, setExpanded: (open: boolean) => void) {
    const [due, markSeen] = useActivityTipSeen()
    return useCallback(() => {
        if (!due || isExpanded) return
        markSeen()
        ask(t`Follow its progress in the activity bar at the bottom of Commander.`, {
            title: t`Transfer started`,
            kind: 'info',
            okLabel: t`Show progress`,
            cancelLabel: t`Not now`,
        }).then((show) => {
            if (show) setExpanded(true)
        })
    }, [due, isExpanded, markSeen, setExpanded])
}

function useEnds(ids: readonly string[]): Record<string, string> {
    const [ends, setEnds] = useState<Record<string, string>>({})
    const key = ids.join(',')
    useEffect(() => {
        const offs = (key ? key.split(',') : []).map((id) =>
            onTransferEnd(id, (state) =>
                setEnds((prev) => (prev[id] === state ? prev : { ...prev, [id]: state }))
            )
        )
        return () => {
            for (const off of offs) off()
        }
    }, [key])
    return ends
}

const NONE: ReadonlySet<string> = new Set()

function useGone(
    ids: readonly string[],
    answer: readonly { transfer: { id: string } }[] | undefined
): ReadonlySet<string> {
    const [restored] = useState(() => ids)
    const [gone, setGone] = useState<ReadonlySet<string> | null>(
        restored.length > 0 ? null : new Set()
    )
    useEffect(() => {
        if (gone !== null || answer === undefined) return
        const known = new Set(answer.map((item) => item.transfer.id))
        setGone(new Set(restored.filter((id) => !known.has(id))))
    }, [gone, answer, restored])
    return gone ?? NONE
}

export default function TransfersBar({
    trackedIds,
    isExpanded,
    onExpandedChange,
    onOpenCompare,
    compareDisabledReason,
    onOpenBatchRename,
    renameDisabledReason,
    renameCount,
}: {
    trackedIds: string[]
    isExpanded: boolean
    onExpandedChange: (expanded: boolean) => void
    onOpenCompare: () => void
    compareDisabledReason?: string
    onOpenBatchRename: () => void
    renameDisabledReason?: string
    renameCount?: number
}) {
    const [, markTipSeen] = useActivityTipSeen()
    const reduceMotion = useReducedMotion()

    const ends = useEnds(trackedIds)
    const { items: trackedItems, query: trackedQuery } = useTracked(trackedIds)
    const endedByCore = new Set(
        trackedItems
            .filter(({ transfer }) => transfer.state !== 'queued' && transfer.state !== 'running')
            .map((item) => item.transfer.id)
    )
    const gone = useGone(trackedIds, trackedQuery.isSuccess ? trackedQuery.data : undefined)
    const isEnded = (id: string) => !!ends[id] || endedByCore.has(id) || gone.has(id)
    const running = trackedIds.filter((id) => !isEnded(id))

    const progress = useLiveNumbers(running.length > 0)
    const jobs = running.map((id) => progress[id]).filter((job) => job !== undefined)
    const endedItems = trackedItems.filter((item) => isEnded(item.transfer.id))
    const ended = endedItems.flatMap((item) => {
        const files = splitFiles(item.files)
        return [...files.transferred, ...files.failed]
    })
    const transferring = jobs.flatMap((job) => job.transferring)
    const checking = jobs.flatMap((job) => job.checking)
    const transferred = [...ended, ...jobs.flatMap((job) => job.transferred)]

    const hasTransfers =
        transferring.length + checking.length + transferred.length > 0 ||
        (endedItems.length > 0 && trackedQuery.isFetching)

    let bytes = 0
    let totalBytes = 0
    let speed = 0
    let eta = 0
    for (const job of jobs) {
        bytes += job.bytes
        totalBytes += job.totalBytes
        speed += job.speed
        eta = Math.max(eta, job.eta ?? 0)
    }
    const failed = transferred.filter((item) => item.error).length
    const done = transferred.length - failed

    const toggleExpanded = useCallback(() => {
        if (!isExpanded) markTipSeen()
        onExpandedChange(!isExpanded)
    }, [isExpanded, onExpandedChange, markTipSeen])

    const handleOpenTransfers = useCallback(() => {
        openHistory()
    }, [])

    const isRunning = running.length > 0
    const isChecking = isRunning && transferring.length === 0 && checking.length > 0

    return (
        <section
            aria-label={t`Page activity`}
            className={cn('mx-2 mb-2 overflow-hidden shrink-0', SURFACE)}
        >
            <div
                className="flex items-center h-12 gap-2 pl-2 pr-2 cursor-pointer select-none"
                onClick={toggleExpanded}
            >
                <div className="flex items-center gap-0.5 shrink-0">
                    <PlacesMenu />
                    <span aria-hidden={true} className="w-px h-5 mx-1.5 bg-divider" />
                    <BarAction
                        label={t`Batch Rename`}
                        icon={PenIcon}
                        count={renameCount}
                        disabledReason={renameDisabledReason}
                        onPress={onOpenBatchRename}
                    />
                    <BarAction
                        label={t({
                            message: 'Compare',
                            comment: 'Button: compares the folders of the two panels.',
                        })}
                        icon={RepeatIcon}
                        disabledReason={compareDisabledReason}
                        onPress={onOpenCompare}
                    />
                </div>

                <div className="flex items-center justify-end flex-1 min-w-0 gap-3 text-[13px] tabular-nums">
                    {isRunning ? (
                        <>
                            <span className="flex items-center min-w-0 gap-2 truncate">
                                <StatusDot kind="active" />
                                <span className="font-medium truncate text-foreground">
                                    {isChecking
                                        ? plural(checking.length, {
                                              one: 'Checking # file',
                                              other: 'Checking # files',
                                          })
                                        : plural(transferring.length, {
                                              one: 'Transferring # file',
                                              other: 'Transferring # files',
                                          })}
                                </span>
                                <Chip
                                    size="sm"
                                    variant="flat"
                                    color="primary"
                                    classNames={{
                                        base: 'hidden h-5 xl:flex',
                                        content: 'px-1 text-[11px] font-semibold',
                                    }}
                                >
                                    {plural(running.length, {
                                        one: '# active',
                                        other: '# active',
                                    })}
                                </Chip>
                            </span>
                            <ToneProgress
                                tone={isChecking ? 'orange' : 'blue'}
                                value={
                                    !isChecking && totalBytes > 0 ? bytes / totalBytes : undefined
                                }
                                label={t`Overall transfer progress`}
                                className="hidden w-32 md:block lg:w-48 shrink-0"
                            />
                            {!isChecking && totalBytes > 0 && (
                                <span className="hidden shrink-0 text-default-500 xl:inline">
                                    {partWords(bytes, totalBytes)}
                                </span>
                            )}
                            {speed > 0 && (
                                <span className="shrink-0 text-default-500">
                                    {speedWords(speed)}
                                </span>
                            )}
                            {eta > 0 && (
                                <span className="hidden shrink-0 text-default-500 lg:inline">
                                    {timeLeft(eta)}
                                </span>
                            )}
                        </>
                    ) : hasTransfers ? (
                        <span className="flex items-center gap-2 truncate">
                            <StatusDot kind={failed > 0 ? 'danger' : 'success'} />
                            <span className="truncate">
                                <EndedWords done={done} failed={failed} />
                            </span>
                        </span>
                    ) : (
                        <span className="flex items-center gap-2 truncate text-default-400">
                            <StatusDot kind="idle" />
                            <Trans>No active transfers</Trans>
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                    <Tooltip content={t`Open History`} {...TIP} closeDelay={0}>
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            radius="md"
                            aria-label={t`Open History`}
                            onPress={handleOpenTransfers}
                            onClick={(e) => e.stopPropagation()}
                            className="text-default-600"
                        >
                            <ArrowUpRightSquareIcon className="size-4" />
                        </Button>
                    </Tooltip>
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        radius="md"
                        aria-label={isExpanded ? t`Hide activity` : t`Show activity`}
                        aria-expanded={isExpanded}
                        onPress={toggleExpanded}
                        onClick={(e) => e.stopPropagation()}
                        className="text-default-600"
                    >
                        {isExpanded ? (
                            <AngleDownSmallIcon className="size-4" />
                        ) : (
                            <AngleUpSmallIcon className="size-4" />
                        )}
                    </Button>
                </div>
            </div>

            <AnimatePresence initial={false}>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: '36vh', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={
                            reduceMotion
                                ? { duration: 0 }
                                : { type: 'spring', duration: 0.3, bounce: 0 }
                        }
                        className="overflow-hidden border-t border-divider"
                    >
                        <ScrollShadow className="h-[36vh] px-2 py-2">
                            {hasTransfers ? (
                                <div className="flex flex-col gap-3">
                                    {checking.length + transferring.length > 0 && (
                                        <ActivityGroup title={t`In progress`}>
                                            {checking.map((item, idx) => (
                                                <TransferItem
                                                    key={`checking-${item.name}-${idx}`}
                                                    item={item}
                                                    status="checking"
                                                />
                                            ))}
                                            {transferring.map((item, idx) => (
                                                <TransferItem
                                                    key={`transferring-${item.name}-${idx}`}
                                                    item={{ ...item, percentage: item.pct }}
                                                    status="transferring"
                                                />
                                            ))}
                                        </ActivityGroup>
                                    )}
                                    {transferred.length > 0 && (
                                        <ActivityGroup
                                            title={t({
                                                message: 'Done',
                                                context: 'heading',
                                                comment:
                                                    'Heading: the files that are transferred, or that failed.',
                                            })}
                                        >
                                            {transferred.map((item, idx) => (
                                                <TransferItem
                                                    key={`transferred-${item.name}-${idx}`}
                                                    item={item}
                                                    status={item.error ? 'error' : 'done'}
                                                />
                                            ))}
                                        </ActivityGroup>
                                    )}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
                                    <IconTile icon={ArrowsRotateIcon} tone="blue" size="lg" />
                                    <p className="text-sm font-semibold">
                                        <Trans>No transfers in progress</Trans>
                                    </p>
                                    <p className="max-w-sm text-xs leading-relaxed text-default-500 text-pretty">
                                        <Trans>
                                            Drag files from one panel onto the other to copy or move
                                            them. Their progress shows here.
                                        </Trans>
                                    </p>
                                </div>
                            )}
                        </ScrollShadow>
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    )
}

function EndedWords({ done, failed }: { done: number; failed: number }) {
    const doneWords = plural(done, { one: '# transferred', other: '# transferred' })
    const failedWords = plural(failed, { one: '# failed', other: '# failed' })
    if (done > 0 && failed > 0) {
        return (
            <Trans comment='How the files of ended transfers went: "12 transferred, 1 failed".'>
                {doneWords}, <span className="font-medium text-danger">{failedWords}</span>
            </Trans>
        )
    }
    if (done > 0) return doneWords
    if (failed > 0) return <span className="font-medium text-danger">{failedWords}</span>
    return <Trans>No active transfers</Trans>
}

function ActivityGroup({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-0.5">
            <h3 className="px-2 pb-1 font-medium tracking-wider uppercase text-[11px] text-default-500">
                {title}
            </h3>
            {children}
        </section>
    )
}

const STATUS: Record<
    'transferring' | 'checking' | 'done' | 'error',
    { icon: ComponentType<{ className?: string }>; tone: Tone }
> = {
    transferring: { icon: ArrowsRotateIcon, tone: 'blue' },
    checking: { icon: SearchIcon, tone: 'orange' },
    done: { icon: CheckIcon, tone: 'green' },
    error: { icon: XmarkIcon, tone: 'red' },
}

function sizeProgress(bytes: number, size: number): string {
    const done = formatBytes(bytes)
    const total = formatBytes(size)
    return t({
        message: `${done} / ${total}`,
        comment: 'How much of a file is transferred: "12 MB / 40 MB".',
    })
}

function TransferItem({
    item,
    status,
}: {
    item: {
        name?: string
        size?: number
        bytes?: number
        percentage?: number
        speed?: number
        error?: string
    }
    status: 'transferring' | 'checking' | 'done' | 'error'
}) {
    const fileName =
        item.name?.split('/').pop() ||
        item.name ||
        t({ message: 'Unknown', comment: 'A file whose name is not known.' })
    const live = status === 'transferring' || status === 'checking'
    const { icon, tone } = STATUS[status]

    return (
        <div className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-default-100 dark:hover:bg-white/5">
            <IconTile
                icon={icon}
                tone={tone}
                size="sm"
                className={cn(
                    status === 'transferring' &&
                        '[&>svg]:animate-spin [&>svg]:[animation-duration:2s] motion-reduce:[&>svg]:animate-none'
                )}
            />

            <div className="flex flex-col flex-1 min-w-0 gap-1">
                <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] truncate" title={item.name}>
                        {fileName}
                    </span>
                    <span className="text-xs shrink-0 text-default-500 tabular-nums">
                        {status === 'error'
                            ? t({ message: 'Failed', context: 'state of a transfer' })
                            : status === 'done'
                              ? formatBytes(item.size || 0)
                              : status === 'checking'
                                ? t({
                                      message: 'Checking…',
                                      comment: 'A file is being compared with the destination.',
                                  })
                                : (item.size || 0) > 0
                                  ? sizeProgress(item.bytes || 0, item.size || 0)
                                  : '—'}
                    </span>
                </div>

                {live && (
                    <div className="flex items-center gap-3">
                        <ToneProgress
                            tone={status === 'checking' ? 'orange' : 'blue'}
                            value={status === 'checking' ? undefined : (item.percentage || 0) / 100}
                            label={t`Transfer progress`}
                            className="flex-1 h-1"
                        />
                        <span className="w-20 text-xs text-right whitespace-nowrap shrink-0 text-default-400 tabular-nums">
                            {(item.speed || 0) > 0 ? speedWords(item.speed || 0) : ''}
                        </span>
                    </div>
                )}

                {status === 'done' && item.name && item.name !== fileName && (
                    <span className="text-xs truncate text-default-400" title={item.name}>
                        {item.name}
                    </span>
                )}

                {status === 'error' && item.error && (
                    <span className="text-xs truncate text-danger" title={item.error}>
                        {item.error}
                    </span>
                )}
            </div>
        </div>
    )
}
