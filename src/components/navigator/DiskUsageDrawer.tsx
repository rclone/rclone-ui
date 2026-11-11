import { Button, cn, DrawerBody, DrawerContent, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleRightSmall as AngleRightSmallIcon,
    ArrowRotateRight as ArrowRotateRightIcon,
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    ChartPieSimple as ChartPieSimpleIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    File as FileIcon2,
    Stop as StopIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type { Browse } from '../../../lib/core/types'
import { formatBytes, formatNumber, timeAgo } from '../../../lib/format'
import { useReconnectOffer } from '../../../lib/reconnect'
import ContentDrawer, { DrawerShellHeader } from '../ContentDrawer'
import { IconTile } from '../look/IconTile'
import { ToneProgress } from '../look/ToneProgress'
import FileIcon from './FileIcon'
import {
    barLength,
    crumbsOf,
    filesText,
    foldersText,
    formatShare,
    parentRel,
    restName,
    rowsToAsk,
    rowsToDraw,
    shareOf,
    type UsageItem,
    type UsageSort,
    usageItems,
} from './usage'
import { type UsageScan, useUsageLevel } from './useDiskUsage'

/** The height of a row in px (h-10). Every row has it, so a row's place is its rank times it. */
const ROW_HEIGHT = 40
/** How long a row takes to glide to its new place, its bar to grow and its numbers to count, in s. */
const MOVE = 0.4
/** Rows drawn above and below the view, so a row moving in arrives from just outside it. */
const OVERSCAN = 6

/** The columns of the list: name, bar, size, share, files, and the row's buttons. */
const COLUMNS =
    'grid grid-cols-[minmax(0,1fr)_minmax(9rem,16rem)_5.5rem_3.75rem_5.5rem_4rem] items-center gap-3'

export interface DiskUsageActions {
    /** Opens a folder in the Commander's active panel. */
    onShow: (path: string) => void
    /** Deletes an entry, after the usual confirmation. */
    onDelete: (item: UsageItem) => void
    onStop: () => void
    onRescan: () => void
    /** The core no longer holds the scan. */
    onLost: (request: string) => void
}

/**
 * A number that counts to its new value instead of jumping, without rendering the row again.
 * With reduced motion, it changes at once.
 */
function Counting({ value, format }: { value: number; format: (n: number) => string }) {
    const reduce = useReducedMotion()
    const mv = useMotionValue(value)
    useEffect(() => {
        if (reduce) {
            mv.set(value)
            return
        }
        const controls = animate(mv, value, { duration: MOVE, ease: 'easeOut' })
        return () => controls.stop()
    }, [value, mv, reduce])
    const text = useTransform(mv, (n) => format(n))
    return <motion.span>{text}</motion.span>
}

const bytesText = (n: number) => formatBytes(Math.round(n))
const countText = (n: number) => formatNumber(Math.round(n))
const shareText = (n: number) => formatShare(n)

/** The size of an entry: "—" for a file whose backend doesn't know it. */
function SizeCell({ item }: { item: UsageItem }) {
    if (!item.isDir && !item.rest && item.unknown > 0) return <span>—</span>
    return <Counting value={item.bytes} format={bytesText} />
}

/** A summary figure: a label and a number that counts as the scan finds more. */
function Figure({
    label,
    value,
    format,
}: {
    label: string
    value: number
    format: (n: number) => string
}) {
    return (
        <div className="flex flex-col gap-0.5 px-3.5 py-2.5 rounded-xl bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.04)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.07)]">
            <span className="text-xs text-default-500">{label}</span>
            <span className="text-lg font-semibold tabular-nums">
                <Counting value={value} format={format} />
            </span>
        </div>
    )
}

/** Where the scan is, in one line: what it reads now, or when it ended and how. */
function ScanStatus({ scan }: { scan: UsageScan }) {
    const progress = scan.progress
    // The age of a finished scan, kept current while the drawer is open.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000)
        return () => clearInterval(timer)
    }, [])
    if (!progress || scan.phase === 'opening') {
        return <Trans>Starting the scan…</Trans>
    }
    if (progress.state === 'scanning') {
        const at = progress.count.at
        return (
            <span className="flex items-center min-w-0 gap-1.5">
                <span className="shrink-0">
                    <Trans>Scanning…</Trans>
                </span>
                {at && (
                    <span className="font-mono truncate text-default-400" title={at}>
                        {at}
                    </span>
                )}
            </span>
        )
    }
    // The clock may be a little behind the core's, and a scan never ends in the future.
    const ago = progress.endedAt ? timeAgo(progress.endedAt, Math.max(now, progress.endedAt)) : ''
    switch (progress.state) {
        case 'stopped':
            return <Trans>Stopped {ago}. The totals show what was found until then.</Trans>
        case 'capped': {
            const most = formatNumber(1_000_000)
            return (
                <Trans>
                    The scan stopped at {most} folders. The totals show what it found until then.
                </Trans>
            )
        }
        case 'failed': {
            const error = progress.error ?? ''
            return <Trans>The scan stopped on an error: {error}</Trans>
        }
        default:
            return <Trans>Scanned {ago}</Trans>
    }
}

/** The notes under the totals: what wasn't counted, and why the numbers may differ. */
function ScanNotes({ progress }: { progress?: Browse.UsageProgress }) {
    if (!progress) return null
    const { unread, unknown } = progress.count
    const notes: string[] = []
    if (unread > 0) {
        notes.push(
            plural(unread, {
                one: "# folder couldn't be read, so its content isn't counted.",
                other: "# folders couldn't be read, so their content isn't counted.",
            })
        )
    }
    if (unknown > 0) {
        notes.push(
            plural(unknown, {
                one: '# file has no known size, so it counts as empty.',
                other: '# files have no known size, so they count as empty.',
            })
        )
    }
    notes.push(
        progress.local
            ? t`Sizes represent file sizes. Mounted remotes and other disks are not included.`
            : t`Old versions and the trash aren’t counted, so this can be less than what the provider reports.`
    )
    return (
        <div className="flex flex-col gap-0.5 text-xs text-default-500">
            {notes.map((note) => (
                <p key={note}>{note}</p>
            ))}
        </div>
    )
}

/** The way up from the folder shown: the scan's root, then each folder down to this one. */
function Crumbs({
    root,
    rel,
    onOpen,
}: {
    root: string
    rel: string
    onOpen: (rel: string) => void
}) {
    const crumbs = crumbsOf(rel)
    const crumb =
        'h-7 px-2 rounded-lg text-[13px] truncate max-w-48 outline-hidden transition-colors duration-100 hover:bg-default-100 focus-visible:ring-2 focus-visible:ring-primary'
    return (
        <nav aria-label={t`Folder`} className="flex items-center min-w-0 gap-0.5">
            <button
                type="button"
                className={cn(crumb, 'font-mono', crumbs.length === 0 && 'font-semibold')}
                onClick={() => onOpen('')}
                title={root}
            >
                {root}
            </button>
            {crumbs.map((c, i) => (
                <span key={c.rel} className="flex items-center min-w-0 gap-0.5">
                    <AngleRightSmallIcon
                        aria-hidden={true}
                        className="size-3.5 shrink-0 text-default-300"
                    />
                    <button
                        type="button"
                        className={cn(crumb, i === crumbs.length - 1 && 'font-semibold')}
                        onClick={() => onOpen(c.rel)}
                        title={c.name}
                    >
                        {c.name}
                    </button>
                </span>
            ))}
        </nav>
    )
}

/** A column's title. The sortable ones are buttons, and the one in use is stronger. */
function ColumnTitle({
    label,
    sort,
    by,
    onSort,
    align = 'left',
}: {
    label: string
    sort?: UsageSort
    by: UsageSort
    onSort: (by: UsageSort) => void
    align?: 'left' | 'right'
}) {
    const className = cn(
        'text-[11px] font-medium uppercase tracking-wide text-default-400',
        align === 'right' && 'text-right'
    )
    if (!sort) return <span className={className}>{label}</span>
    return (
        <button
            type="button"
            aria-pressed={by === sort}
            onClick={() => onSort(sort)}
            className={cn(
                className,
                align === 'right' ? 'justify-self-end' : 'justify-self-start',
                'outline-hidden hover:text-default-600 focus-visible:text-primary',
                by === sort && 'text-foreground'
            )}
        >
            {label}
        </button>
    )
}

/** An entry, or the folder's smaller files, as a row of the list. */
function UsageRowView({
    item,
    largest,
    total,
    highlighted,
    scanning,
    onPick,
    onOpen,
    onShow,
    onDelete,
}: {
    item: UsageItem
    largest: number
    total: number
    highlighted: boolean
    scanning: boolean
    onPick: (item: UsageItem) => void
    onOpen: (item: UsageItem) => void
    onShow: (item: UsageItem) => void
    onDelete: (item: UsageItem) => void
}) {
    const name = item.rest ? restName(item.files) : item.name
    const warning = item.unread
        ? t`This folder couldn’t be read, so its content isn’t counted.`
        : item.unreadBelow > 0
          ? plural(item.unreadBelow, {
                one: "# folder inside couldn't be read, so its content isn't counted.",
                other: "# folders inside couldn't be read, so their content isn't counted.",
            })
          : undefined
    return (
        <div
            aria-current={highlighted || undefined}
            onClick={() => (item.isDir ? onOpen(item) : onPick(item))}
            className={cn(
                COLUMNS,
                'group/row h-10 px-3 rounded-lg text-[13px] select-none',
                item.isDir && 'cursor-pointer',
                highlighted ? 'bg-primary/10' : 'hover:bg-default-100/70'
            )}
        >
            <span className="flex items-center min-w-0 gap-2.5">
                {item.rest ? (
                    <FileIcon2 className="size-5 shrink-0 text-default-400" />
                ) : (
                    <FileIcon
                        entry={{
                            key: item.key,
                            name: item.name,
                            isDir: item.isDir,
                            fullPath: item.path,
                        }}
                        size="md"
                    />
                )}
                <span
                    className={cn('truncate', item.rest && 'text-default-500')}
                    title={item.rest ? undefined : item.path}
                >
                    {name}
                </span>
                {warning && (
                    <Tooltip content={warning} size="sm" closeDelay={0}>
                        <ExclamationTriangleIcon
                            aria-label={warning}
                            className="size-3.5 shrink-0 text-warning-500"
                        />
                    </Tooltip>
                )}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-default-200/60">
                <span
                    className={cn(
                        'block h-full origin-left rounded-full transition-transform ease-out motion-reduce:transition-none',
                        item.isDir
                            ? 'bg-linear-to-r from-violet-500 to-fuchsia-500'
                            : 'bg-linear-to-r from-sky-500 to-cyan-400'
                    )}
                    style={{
                        transform: `scaleX(${barLength(item.bytes, largest)})`,
                        transitionDuration: `${MOVE * 1000}ms`,
                    }}
                />
            </span>
            <span className="font-medium text-right tabular-nums">
                <SizeCell item={item} />
            </span>
            <span className="text-right tabular-nums text-default-500">
                <Counting value={shareOf(item.bytes, total)} format={shareText} />
            </span>
            <span className="text-right tabular-nums text-default-500">
                {item.isDir || item.rest ? <Counting value={item.files} format={countText} /> : ''}
            </span>
            <span
                className={cn(
                    'flex justify-end gap-0.5 transition-opacity duration-100',
                    highlighted ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
                )}
            >
                {!item.rest && (
                    <>
                        <Tooltip content={t`Show in panel`} size="sm" closeDelay={0}>
                            <Button
                                isIconOnly={true}
                                size="sm"
                                variant="light"
                                radius="md"
                                aria-label={t`Show in panel`}
                                className="min-w-7 w-7 h-7"
                                onPress={() => onShow(item)}
                            >
                                <ArrowUpRightSquareIcon className="size-4" />
                            </Button>
                        </Tooltip>
                        <Tooltip
                            content={
                                scanning
                                    ? t`Stop the scan or wait for it to end to delete.`
                                    : t({
                                          message: 'Delete',
                                          comment: 'Button: deletes the file or folder.',
                                      })
                            }
                            size="sm"
                            closeDelay={0}
                        >
                            {/* A disabled button gets no hover, so the tooltip is on a wrapper. */}
                            <span>
                                <Button
                                    isIconOnly={true}
                                    size="sm"
                                    variant="light"
                                    radius="md"
                                    color="danger"
                                    aria-label={t({
                                        message: 'Delete',
                                        comment: 'Button: deletes the file or folder.',
                                    })}
                                    isDisabled={scanning}
                                    className="min-w-7 w-7 h-7"
                                    onPress={() => onDelete(item)}
                                >
                                    <TrashIcon className="size-4" />
                                </Button>
                            </span>
                        </Tooltip>
                    </>
                )}
            </span>
        </div>
    )
}

/**
 * The rows of the folder shown, each in its place by rank. A row that changes rank glides to its
 * new place. Only the rows in view are drawn, together with those leaving it, so a folder with
 * thousands of entries scrolls as easily as a small one.
 */
function UsageList({
    items,
    more,
    total,
    highlighted,
    scanning,
    onPick,
    onOpen,
    onShow,
    onDelete,
    onLimit,
    listRef,
}: {
    items: UsageItem[]
    more: number
    total: number
    highlighted: string | null
    scanning: boolean
    onPick: (item: UsageItem) => void
    onOpen: (item: UsageItem) => void
    onShow: (item: UsageItem) => void
    onDelete: (item: UsageItem) => void
    onLimit: (limit: number) => void
    listRef: RefObject<HTMLDivElement | null>
}) {
    const reduce = useReducedMotion()
    const [view, setView] = useState({ top: 0, height: 600 })
    useLayoutEffect(() => {
        const el = listRef.current
        if (!el) return
        const measure = () => setView({ top: el.scrollTop, height: el.clientHeight })
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
    }, [listRef])
    const frame = useRef<number | null>(null)
    const onScroll = useCallback(() => {
        if (frame.current !== null) return
        frame.current = requestAnimationFrame(() => {
            frame.current = null
            const el = listRef.current
            if (el) setView({ top: el.scrollTop, height: el.clientHeight })
        })
    }, [listRef])
    useEffect(
        () => () => {
            if (frame.current !== null) cancelAnimationFrame(frame.current)
        },
        []
    )
    useEffect(() => {
        onLimit(rowsToAsk(view.top, view.height, ROW_HEIGHT))
    }, [view, onLimit])

    const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN)
    const last = Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN
    // The ranks of the last rows drawn, so a row that moves out of view glides away.
    const was = useRef<ReadonlyMap<string, number>>(new Map())
    const drawn = rowsToDraw(items, was.current, first, last)
    useEffect(() => {
        was.current = new Map(items.map((item, rank) => [item.key, rank]))
    }, [items])
    // The bars measure against the largest entry, which is the first one when sorted by size.
    const largest = useMemo(
        () => items.reduce((most, item) => Math.max(most, item.bytes), 0),
        [items]
    )

    return (
        <div ref={listRef} onScroll={onScroll} className="h-full px-5 pb-6 overflow-y-auto">
            <div className="relative w-full" style={{ height: (items.length + more) * ROW_HEIGHT }}>
                {drawn.map(({ item, rank }) => (
                    <motion.div
                        key={item.key}
                        className="absolute top-0 left-0 w-full"
                        initial={{ opacity: 0, y: rank * ROW_HEIGHT }}
                        animate={{ opacity: 1, y: rank * ROW_HEIGHT }}
                        transition={{
                            y: reduce ? { duration: 0 } : { duration: MOVE, ease: 'easeInOut' },
                            opacity: { duration: reduce ? 0 : 0.2 },
                        }}
                    >
                        <UsageRowView
                            item={item}
                            largest={largest}
                            total={total}
                            highlighted={item.key === highlighted}
                            scanning={scanning}
                            onPick={onPick}
                            onOpen={onOpen}
                            onShow={onShow}
                            onDelete={onDelete}
                        />
                    </motion.div>
                ))}
            </div>
        </div>
    )
}

/** Rows that stand in for the first entries while the scan starts. */
function Placeholder() {
    return (
        <div className="flex flex-col gap-0 px-5" aria-hidden={true}>
            {[0.9, 0.7, 0.55, 0.4, 0.3].map((width) => (
                <div key={width} className={cn(COLUMNS, 'h-10 px-3')}>
                    <span className="flex items-center gap-2.5">
                        <span className="rounded-md size-5 bg-default-200/70 animate-pulse" />
                        <span
                            className="h-3 rounded-full bg-default-200/70 animate-pulse"
                            style={{ width: `${width * 60}%` }}
                        />
                    </span>
                    <span
                        className="h-1.5 rounded-full bg-default-200/70 animate-pulse"
                        style={{ width: `${width * 100}%` }}
                    />
                </div>
            ))}
        </div>
    )
}

/** A whole-drawer message, such as an error, with its action. */
function Notice({
    icon,
    tone,
    title,
    detail,
    action,
}: {
    icon: typeof ChartPieSimpleIcon
    tone: 'red' | 'violet'
    title: ReactNode
    detail?: ReactNode
    action?: ReactNode
}) {
    return (
        <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
            <IconTile icon={icon} tone={tone} size="xl" />
            <div className="flex flex-col items-center gap-1 max-w-96">
                <p className="text-sm font-semibold">{title}</p>
                {detail && (
                    <p className="text-xs text-default-500 [overflow-wrap:anywhere]">{detail}</p>
                )}
            </div>
            {action}
        </div>
    )
}

// Mounted only while the drawer is open, so it reads the scan only then. It always opens at the
// scan's root. The scan itself goes on while the drawer is closed.
function UsageView({
    scan,
    actions,
    onClose,
}: {
    scan: UsageScan
    actions: DiskUsageActions
    onClose: () => void
}) {
    const [rel, setRel] = useState('')
    const [by, setBy] = useState<UsageSort>('size')
    const [limit, setLimit] = useState(200)
    const [highlighted, setHighlighted] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const scanning = scan.phase === 'opening' || scan.phase === 'scanning'
    const progress = scan.progress

    const openFolder = useCallback((next: string) => {
        setRel(next)
        setHighlighted(null)
        listRef.current?.scrollTo({ top: 0 })
    }, [])
    const shown = useUsageLevel(
        scan,
        rel,
        by,
        limit,
        useCallback(() => openFolder(parentRel(rel)), [openFolder, rel]),
        actions.onLost
    )
    // Rows of another folder are never shown, but rows in another order are: they glide to it.
    const level = shown && shown.rel === rel ? shown : null
    const items = useMemo(() => (level ? usageItems(level.level, level.by) : []), [level])
    const total = level?.level.total.bytes ?? 0
    useReconnectOffer(scan.reconnect, actions.onRescan)

    const open = useCallback((item: UsageItem) => openFolder(item.rel), [openFolder])
    const pick = useCallback((item: UsageItem) => setHighlighted(item.key), [])
    const show = useCallback(
        (item: UsageItem) => {
            actions.onShow(item.isDir ? item.path : (level?.level.total.path ?? item.path))
            onClose()
        },
        [actions, level, onClose]
    )

    // The arrows move the highlight, Enter opens a folder, and Backspace goes up.
    const onKeyDown = useCallback(
        (e: ReactKeyboardEvent) => {
            const at = items.findIndex((item) => item.key === highlighted)
            const move = (to: number) => {
                const item = items[Math.max(0, Math.min(items.length - 1, to))]
                if (!item) return
                setHighlighted(item.key)
                const el = listRef.current
                const rank = items.indexOf(item)
                if (el) {
                    const top = rank * ROW_HEIGHT
                    if (top < el.scrollTop) el.scrollTop = top
                    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
                        el.scrollTop = top + ROW_HEIGHT - el.clientHeight
                    }
                }
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                move(at + 1)
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                move(at < 0 ? 0 : at - 1)
            } else if (e.key === 'Enter' && at >= 0 && items[at].isDir) {
                e.preventDefault()
                open(items[at])
            } else if (e.key === 'Backspace' && rel) {
                e.preventDefault()
                openFolder(parentRel(rel))
            }
        },
        [items, highlighted, open, openFolder, rel]
    )
    // The list takes the keyboard when the drawer opens.
    const body = useRef<HTMLDivElement>(null)
    useEffect(() => body.current?.focus(), [])

    const root = progress?.root ?? scan.from ?? ''
    const headerActions =
        scan.phase === 'failed' || scan.phase === 'gone' ? null : scanning ? (
            <Button
                size="sm"
                variant="flat"
                startContent={<StopIcon className="size-3.5" />}
                onPress={actions.onStop}
                isDisabled={scan.phase === 'opening'}
            >
                <Trans>Stop</Trans>
            </Button>
        ) : (
            <Button
                size="sm"
                variant="flat"
                startContent={<ArrowRotateRightIcon className="size-3.5" />}
                onPress={actions.onRescan}
            >
                <Trans>Rescan</Trans>
            </Button>
        )

    let content: ReactNode
    if (scan.phase === 'failed') {
        content = (
            <Notice
                icon={ExclamationTriangleIcon}
                tone="red"
                title={<Trans>This couldn’t be scanned</Trans>}
                detail={scan.error}
                action={
                    <Button size="sm" variant="flat" onPress={actions.onRescan}>
                        <Trans>Try again</Trans>
                    </Button>
                }
            />
        )
    } else if (scan.phase === 'gone') {
        content = (
            <Notice
                icon={ChartPieSimpleIcon}
                tone="violet"
                title={<Trans>This scan is no longer available</Trans>}
                detail={
                    <Trans>
                        A scan that isn’t looked at for a while is cleared to free memory.
                    </Trans>
                }
                action={
                    <Button size="sm" variant="flat" onPress={actions.onRescan}>
                        <Trans>Scan again</Trans>
                    </Button>
                }
            />
        )
    } else {
        const count = progress?.count
        content = (
            <div className="flex flex-col h-full">
                <div className="flex flex-col gap-3 px-5 pt-4 pb-3 shrink-0">
                    <div className="grid grid-cols-3 gap-2">
                        <Figure label={t`Size`} value={count?.bytes ?? 0} format={bytesText} />
                        <Figure label={t`Files`} value={count?.files ?? 0} format={countText} />
                        <Figure label={t`Folders`} value={count?.folders ?? 0} format={countText} />
                    </div>
                    <div className="flex flex-col gap-1">
                        <p className="flex min-w-0 text-[13px] text-default-600">
                            <ScanStatus scan={scan} />
                        </p>
                        <ScanNotes progress={progress} />
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3 px-5 pb-2 shrink-0">
                    <Crumbs root={root} rel={rel} onOpen={openFolder} />
                    {level && rel && (
                        <span className="text-xs shrink-0 text-default-500 tabular-nums">
                            {filesText(level.level.total.files)} ·{' '}
                            {foldersText(level.level.total.folders)}
                        </span>
                    )}
                </div>
                <div className={cn(COLUMNS, 'mx-5 px-3 pb-1.5 border-b border-divider shrink-0')}>
                    <ColumnTitle label={t`Name`} sort="name" by={by} onSort={setBy} />
                    <span />
                    <ColumnTitle label={t`Size`} sort="size" by={by} onSort={setBy} align="right" />
                    <ColumnTitle
                        label={t({
                            message: 'Share',
                            comment: 'Column: part of the folder’s size.',
                        })}
                        by={by}
                        onSort={setBy}
                        align="right"
                    />
                    <ColumnTitle
                        label={t`Files`}
                        sort="files"
                        by={by}
                        onSort={setBy}
                        align="right"
                    />
                    <span />
                </div>
                <div className="flex-1 min-h-0 pt-1">
                    {items.length > 0 ? (
                        <UsageList
                            items={items}
                            more={level?.level.more ?? 0}
                            total={total}
                            highlighted={highlighted}
                            scanning={scanning}
                            onPick={pick}
                            onOpen={open}
                            onShow={show}
                            onDelete={actions.onDelete}
                            onLimit={setLimit}
                            listRef={listRef}
                        />
                    ) : level && !scanning ? (
                        <p className="px-8 py-6 text-sm text-default-500">
                            <Trans>This folder is empty.</Trans>
                        </p>
                    ) : (
                        <Placeholder />
                    )}
                </div>
            </div>
        )
    }

    return (
        <>
            <DrawerShellHeader
                icon={ChartPieSimpleIcon}
                tone="violet"
                title={t`Disk Usage`}
                description={
                    <span className="font-mono" title={root}>
                        {root}
                    </span>
                }
                actions={headerActions}
                onClose={onClose}
                inset={true}
            />
            <div className="h-0.5 shrink-0">
                {scanning && (
                    <ToneProgress
                        tone="violet"
                        label={t`Scanning`}
                        className="h-0.5 rounded-none"
                    />
                )}
            </div>
            <DrawerBody className="p-0 outline-hidden">
                <div
                    ref={body}
                    tabIndex={-1}
                    onKeyDown={onKeyDown}
                    className="h-full outline-hidden"
                >
                    {content}
                </div>
            </DrawerBody>
        </>
    )
}

/**
 * Disk Usage: what takes the space on a whole remote or disk, largest first, as the scan finds
 * it. The scan belongs to the page (`useDiskUsage`), so it goes on when the drawer closes, and
 * the drawer shows it again when it opens.
 */
export default function DiskUsageDrawer({
    isOpen,
    onClose,
    scan,
    actions,
}: {
    isOpen: boolean
    onClose: () => void
    scan: UsageScan
    actions: DiskUsageActions
}) {
    return (
        <ContentDrawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent>
                {() => <UsageView scan={scan} actions={actions} onClose={onClose} />}
            </DrawerContent>
        </ContentDrawer>
    )
}
