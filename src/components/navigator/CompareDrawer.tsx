import { Button, cn, DrawerBody, DrawerContent, ScrollShadow } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Folder as FolderIcon,
    Repeat as RepeatIcon,
} from '@zappicon/react'
import { useCallback, useMemo, useRef } from 'react'
import type { Browse } from '../../../lib/core/types'
import { formatBytes, formatNumber } from '../../../lib/format'
import { useReconnectOffer } from '../../../lib/reconnect'
import ContentDrawer, { DrawerShellHeader } from '../ContentDrawer'
import { IconTile } from '../look/IconTile'
import { ToneProgress } from '../look/ToneProgress'
import {
    BUCKETS,
    bucketed,
    type CompareClass,
    type CompareEntry,
    type CompareLine,
    type ComparePair,
    type CompareResult,
    compareLines,
} from './compare'
import FileIcon from './FileIcon'
import { useFileDates } from './fileDates'
import { useJob } from './jobs'
import type { RemoteString } from './types'
import { panelFolder, serializeRemotePath } from './utils'

// The current location of a Browser panel, as reported by FilePanel's onNavigate.
export type PanelLocation = { remote: RemoteString; path: string }

/** The maximum number of names in a compare. Past it, the drawer says so. */
const COMPARE_CAP = 20_000

/** Heights in px of a bucket's title bar (h-9), a pair (h-11), and the gap between buckets. */
const HEADER_HEIGHT = 36
const ROW_HEIGHT = 44
const BUCKET_GAP = 16

/**
 * The height of a line. The box around a bucket's pairs adds a border above the first row and
 * below the last. When another bucket follows, the last row also adds the gap between them. The
 * gap belongs to the row rather than the next header, so a sticky header looks the same as one
 * in its normal place.
 */
function lineHeight(line: CompareLine, hasNext: boolean): number {
    if (line.kind === 'header') return HEADER_HEIGHT
    return (
        ROW_HEIGHT +
        (line.first ? 1 : 0) +
        (line.last ? 1 : 0) +
        (line.last && hasNext ? BUCKET_GAP : 0)
    )
}

/** The panel's folder as the rclone path that the compare expects, or null when it shows none. */
function comparedPath(loc: PanelLocation | null): string | null {
    return loc ? panelFolder(loc.remote, loc.path) : null
}

function locationLabel(loc: PanelLocation | null): string {
    if (!loc) return ''
    if (loc.remote === 'UI_LOCAL_FS') return loc.path || '/'
    return serializeRemotePath(loc.remote ?? '', loc.path)
}

/** The color of each bucket's dot, so the summary and the list read the same way. */
const BUCKET_DOT: Record<CompareClass, string> = {
    onlyLeft: 'bg-sky-500',
    onlyRight: 'bg-violet-500',
    sameByName: 'bg-amber-500',
    sameByHash: 'bg-emerald-500',
}

// One side of a pair. A missing entry (the empty side of an "only on" row) is a spacer of the
// same height, so the two sides stay aligned.
function CompareCell({ entry, last }: { entry?: CompareEntry; last: boolean }) {
    const edge = last ? '' : 'border-b border-divider'
    if (!entry) {
        return (
            <div
                className={cn(
                    'h-11 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.025)_6px_12px)] dark:bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(255_255_255/0.025)_6px_12px)] bg-content1',
                    edge
                )}
            />
        )
    }
    return (
        <div className={cn('flex items-center h-11 gap-2.5 px-3 bg-content1', edge)}>
            <FileIcon entry={entry} size="md" />
            <span className="flex-1 text-[13px] truncate" title={entry.fullPath}>
                {entry.name}
            </span>
            <span className="text-xs text-default-400 shrink-0 tabular-nums">
                {entry.isDir ? '' : entry.size === undefined ? '—' : formatBytes(entry.size)}
            </span>
        </div>
    )
}

// A bucket's pairs look like one panel with two columns, and each row is a slice of it.
function ComparePairRow({
    pair,
    first,
    last,
}: {
    pair: ComparePair
    first: boolean
    last: boolean
}) {
    return (
        <div
            className={cn(
                'grid grid-cols-2 overflow-hidden border-x gap-px border-divider bg-divider',
                first && 'border-t rounded-t-xl',
                last && 'border-b rounded-b-xl'
            )}
        >
            <CompareCell entry={pair.left} last={last} />
            <CompareCell entry={pair.right} last={last} />
        </div>
    )
}

function CompareHeader({ title, count, bucket }: { title: string; count: number; bucket: string }) {
    return (
        <div className="flex items-center h-9 gap-2 px-1 bg-[#f5f5f7]/90 backdrop-blur-xs dark:bg-[#161618]/90">
            <span
                aria-hidden={true}
                className={cn('rounded-full size-2', BUCKET_DOT[bucket as CompareClass])}
            />
            <h3 className="text-[13px] font-semibold">{title}</h3>
            <span className="rounded-full bg-default-200/70 px-2 py-0.5 text-[11px] font-medium text-default-600 tabular-nums">
                {formatNumber(count)}
            </span>
        </div>
    )
}

/**
 * Shows the buckets as one virtualized list, so only the rows in view are rendered. The header
 * of the bucket at the top of the view stays pinned while its rows scroll past.
 */
function CompareList({ data }: { data: CompareResult }) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const lines = useMemo(() => compareLines(data), [data])
    const headers = useMemo(() => {
        const at: number[] = []
        for (let i = 0; i < lines.length; i++) if (lines[i].kind === 'header') at.push(i)
        return at
    }, [lines])
    // The pinned header: the last header at or above the first line in view.
    const stuck = useRef(0)
    const rangeExtractor = useCallback(
        (range: Range) => {
            let top = 0
            for (const i of headers) if (i <= range.startIndex) top = i
            stuck.current = top
            return [...new Set([top, ...defaultRangeExtractor(range)])].sort((a, b) => a - b)
        },
        [headers]
    )
    // Keyed by line, so a new result is measured again.
    const getItemKey = useCallback((i: number) => lines[i].key, [lines])
    const virtualizer = useVirtualizer({
        count: lines.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (i) => lineHeight(lines[i], i < lines.length - 1),
        getItemKey,
        rangeExtractor,
        overscan: 10,
    })

    return (
        <ScrollShadow ref={scrollRef} className="h-full px-5 pb-6">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                    const line = lines[item.index]
                    if (line.kind === 'header' && item.index === stuck.current) {
                        // Placed in the normal flow at the top of the list, so it sticks to the
                        // top of the view.
                        return (
                            <div key={item.key} className="sticky top-0 z-10">
                                <CompareHeader
                                    title={line.title}
                                    count={line.count}
                                    bucket={line.key}
                                />
                            </div>
                        )
                    }
                    return (
                        <div
                            key={item.key}
                            className="absolute top-0 left-0 w-full"
                            style={{
                                height: item.size,
                                transform: `translateY(${item.start}px)`,
                            }}
                        >
                            {line.kind === 'header' ? (
                                <CompareHeader
                                    title={line.title}
                                    count={line.count}
                                    bucket={line.key}
                                />
                            ) : (
                                <ComparePairRow
                                    pair={line.pair}
                                    first={line.first}
                                    last={line.last}
                                />
                            )}
                        </div>
                    )
                })}
            </div>
        </ScrollShadow>
    )
}

// Mounted only while the drawer is open, so the compare runs while the drawer is open and is
// cancelled when it closes. Each opening compares again, because nothing tells the drawer whether
// the folders changed in the meantime.
function CompareView({
    left,
    right,
    onClose,
}: {
    left: PanelLocation | null
    right: PanelLocation | null
    onClose: () => void
}) {
    const leftPath = comparedPath(left)
    const rightPath = comparedPath(right)
    const [fileDates] = useFileDates()
    const job = useJob<Browse.Pair>(
        'compare',
        leftPath !== null && rightPath !== null
            ? { left: leftPath, right: rightPath, fileDates }
            : null,
        { cap: COMPARE_CAP, fresh: true }
    )
    useReconnectOffer(job.reconnect, job.refresh)
    const data = useMemo(
        () => (job.phase === 'done' || job.items.length > 0 ? bucketed(job.items) : undefined),
        [job.phase, job.items]
    )
    const isLoading = job.phase === 'running' && job.items.length === 0
    const error =
        job.phase === 'failed' ? new Error(job.error ?? t`The folders couldn’t be compared`) : null
    const isEmpty = job.phase === 'done' && !!data && BUCKETS.every((b) => data[b.key].length === 0)
    const cap = formatNumber(COMPARE_CAP)

    return (
        <>
            <DrawerShellHeader
                icon={RepeatIcon}
                tone="blue"
                title={t({
                    message: 'Compare',
                    comment: 'Title of the drawer that compares two folders.',
                })}
                description={
                    <span className="flex items-center min-w-0 gap-1.5">
                        <span className="truncate" title={locationLabel(left)}>
                            {locationLabel(left)}
                        </span>
                        <ArrowRightSmallIcon className="size-3.5 shrink-0" />
                        <span className="truncate" title={locationLabel(right)}>
                            {locationLabel(right)}
                        </span>
                    </span>
                }
                onClose={onClose}
                inset={true}
            />
            <DrawerBody className="p-0">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
                        <IconTile icon={RepeatIcon} tone="blue" size="xl" />
                        <div className="flex flex-col items-center gap-1">
                            <p className="text-sm font-semibold">
                                <Trans>Comparing the two folders</Trans>
                            </p>
                            <p className="text-xs text-default-500">
                                <Trans>
                                    Both are listed with their hashes, so this can take a moment.
                                </Trans>
                            </p>
                        </div>
                        <ToneProgress
                            tone="blue"
                            label={t`Comparing folders`}
                            className="max-w-56"
                        />
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
                        <IconTile icon={ExclamationTriangleIcon} tone="red" size="xl" />
                        <div className="flex flex-col items-center gap-1 max-w-96">
                            <p className="text-sm font-semibold">
                                <Trans>The folders couldn’t be compared</Trans>
                            </p>
                            <p className="text-xs text-default-500 [overflow-wrap:anywhere]">
                                {error.message}
                            </p>
                        </div>
                        <Button size="sm" variant="flat" onPress={job.refresh}>
                            <Trans>Try again</Trans>
                        </Button>
                    </div>
                ) : isEmpty ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                        <IconTile icon={FolderIcon} tone="blue" size="xl" />
                        <p className="text-sm text-default-500">
                            <Trans>Nothing to compare — both folders are empty.</Trans>
                        </p>
                    </div>
                ) : data ? (
                    <div className="flex flex-col h-full">
                        <div className="grid grid-cols-2 gap-2 px-5 pt-4 pb-3 sm:grid-cols-4 shrink-0">
                            {BUCKETS.map((bucket) => (
                                <div
                                    key={bucket.key}
                                    className="flex flex-col gap-0.5 px-3.5 py-2.5 rounded-xl bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.04)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.07)]"
                                >
                                    <span className="flex items-center gap-1.5 text-xs text-default-500">
                                        <span
                                            aria-hidden={true}
                                            className={cn(
                                                'rounded-full size-1.5',
                                                BUCKET_DOT[bucket.key]
                                            )}
                                        />
                                        {bucket.title}
                                    </span>
                                    <span className="text-lg font-semibold tabular-nums">
                                        {formatNumber(data[bucket.key].length)}
                                    </span>
                                </div>
                            ))}
                        </div>
                        {job.capped && (
                            <p className="px-5 pb-2 text-xs shrink-0 text-warning-600 dark:text-warning-500">
                                <Trans>
                                    A folder holds more than {cap} names, so the compare stopped
                                    there: some names are missing, and some may be in the wrong
                                    group.
                                </Trans>
                            </p>
                        )}
                        <div className="flex-1 min-h-0">
                            <CompareList data={data} />
                        </div>
                    </div>
                ) : null}
            </DrawerBody>
        </>
    )
}

export default function CompareDrawer({
    isOpen,
    onClose,
    left,
    right,
}: {
    isOpen: boolean
    onClose: () => void
    left: PanelLocation | null
    right: PanelLocation | null
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
                {() => <CompareView left={left} right={right} onClose={onClose} />}
            </DrawerContent>
        </ContentDrawer>
    )
}
