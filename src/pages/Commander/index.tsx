import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { coreError, reportError } from '../../../lib/errors'
import { formOf } from '../../../lib/operations'
import { clipboard, dataDir, openWindow, platform, save } from '../../../lib/shell'
import { track } from '../../../lib/telemetry'
import { startTransfer } from '../../../lib/transfers'
import {
    BatchRenameDrawer,
    CompareDrawer,
    type DiskUsageActions,
    DiskUsageDrawer,
    FilePanel,
    type FilePanelHandle,
    onTransferEnd,
    type PanelLocation,
    publicLink,
    type UsageItem,
    useDiskUsage,
    useEntryActions,
} from '../../components/navigator'
import { usePeekKey } from '../../components/navigator/peek'
import type { Entry, SelectItem, Sort } from '../../components/navigator/types'
import { BY_NAME, panelFolder, placeOf } from '../../components/navigator/utils'
import { toastSuccess } from '../../components/toast'
import { usePageQuery } from '../../route'
import Intro from './Intro'
import OperationDialog from './OperationDialog'
import {
    loadSnapshot,
    openingOf,
    type Place,
    samePlace,
    saveSnapshot,
    scrollAfterMove,
    snapshotKey,
    TRACKED_MAX,
} from './snapshot'
import TransfersBar, { useActivityTip } from './TransfersBar'

const SAVE_SCROLL_AFTER = 250

type Side = 'left' | 'right'

function remoteOf(loc: PanelLocation | null): string | null {
    return !loc?.remote || loc.remote === 'UI_LOCAL_FS' ? null : loc.remote
}

function parsePanelTarget(raw: string | null): Place | undefined {
    if (!raw) return undefined
    const place = placeOf(raw)
    return { remote: place.remote, path: place.cwd }
}

function useSnapshot() {
    const [key] = useState(() => snapshotKey(dataDir()))
    const query = usePageQuery()
    const [opening] = useState(() => {
        const snapshot = loadSnapshot(key)
        return {
            left: openingOf(parsePanelTarget(query.get('left')), snapshot.left),
            right: openingOf(
                parsePanelTarget(query.get('right') ?? query.get('path')),
                snapshot.right
            ),
            tracked: snapshot.tracked,
            barOpen: snapshot.barOpen,
        }
    })

    const [places, setPlaces] = useState<Record<Side, Place | undefined>>({
        left: opening.left.place,
        right: opening.right.place,
    })
    const [sorts, setSorts] = useState<Record<Side, Sort>>({
        left: opening.left.restore?.sort ?? BY_NAME,
        right: opening.right.restore?.sort ?? BY_NAME,
    })
    const [selections, setSelections] = useState<Record<Side, SelectItem[]>>({
        left: opening.left.restore?.selection ?? [],
        right: opening.right.restore?.selection ?? [],
    })
    const [tracked, setTracked] = useState(opening.tracked)
    const [barOpen, setBarOpen] = useState(opening.barOpen)
    const scrolls = useRef<Record<Side, number>>({
        left: opening.left.restore?.scrollTop ?? 0,
        right: opening.right.restore?.scrollTop ?? 0,
    })

    const kept = useRef({ places, sorts, selections, tracked, barOpen })
    const save = useCallback(() => {
        const now = kept.current
        const panel = (side: Side) => {
            const place = now.places[side]
            if (!place) return undefined
            return {
                place,
                sort: now.sorts[side],
                selection: now.selections[side],
                scrollTop: scrolls.current[side],
            }
        }
        saveSnapshot(key, {
            left: panel('left'),
            right: panel('right'),
            tracked: now.tracked,
            barOpen: now.barOpen,
        })
    }, [key])
    useEffect(() => {
        kept.current = { places, sorts, selections, tracked, barOpen }
        save()
    }, [places, sorts, selections, tracked, barOpen, save])

    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(
        () => () => {
            if (timer.current !== null) clearTimeout(timer.current)
            save()
        },
        [save]
    )
    const scrolled = useCallback(
        (side: Side, top: number) => {
            scrolls.current[side] = top
            if (timer.current !== null) clearTimeout(timer.current)
            timer.current = setTimeout(save, SAVE_SCROLL_AFTER)
        },
        [save]
    )
    const placesNow = useRef(places)
    const moved = useCallback((side: Side, place: Place) => {
        const was = placesNow.current[side]
        if (was && samePlace(was, place)) return
        scrolls.current[side] = scrollAfterMove(was, place, scrolls.current[side])
        placesNow.current = { ...placesNow.current, [side]: place }
        setPlaces(placesNow.current)
    }, [])
    const sorted = useCallback((side: Side, sort: Sort) => {
        setSorts((was) => (was[side] === sort ? was : { ...was, [side]: sort }))
    }, [])
    const selected = useCallback((side: Side, selection: SelectItem[]) => {
        setSelections((was) => ({ ...was, [side]: selection }))
    }, [])

    return { opening, tracked, setTracked, barOpen, setBarOpen, moved, sorted, selected, scrolled }
}

export default function Commander() {
    const leftPanelRef = useRef<FilePanelHandle>(null)
    const rightPanelRef = useRef<FilePanelHandle>(null)
    const memory = useSnapshot()
    const { opening, moved, sorted, selected, scrolled } = memory

    const [dropOperation, setDropOperation] = useState<{
        items: SelectItem[]
        destination: string
    } | null>(null)

    const { tracked: trackedIds, setTracked: setTrackedIds } = memory
    const showActivityTip = useActivityTip(memory.barOpen, memory.setBarOpen)
    const handleJobStarted = useCallback(
        (id: string) => {
            setTrackedIds((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-TRACKED_MAX)))
            showActivityTip()
        },
        [setTrackedIds, showActivityTip]
    )

    const refreshPanels = useCallback(() => {
        leftPanelRef.current?.refresh()
        rightPanelRef.current?.refresh()
    }, [])

    const [leftLoc, setLeftLoc] = useState<PanelLocation | null>(null)
    const [rightLoc, setRightLoc] = useState<PanelLocation | null>(null)
    const handleLeftNavigate = useCallback(
        (remote: string, path: string) => {
            setLeftLoc({ remote, path })
            moved('left', { remote, path })
        },
        [moved]
    )
    const handleRightNavigate = useCallback(
        (remote: string, path: string) => {
            setRightLoc({ remote, path })
            moved('right', { remote, path })
        },
        [moved]
    )
    const [leftSel, setLeftSel] = useState<SelectItem[]>([])
    const [rightSel, setRightSel] = useState<SelectItem[]>([])
    const handleLeftSelection = useCallback(
        (selection: SelectItem[]) => {
            setLeftSel(selection)
            selected('left', selection)
        },
        [selected]
    )
    const handleRightSelection = useCallback(
        (selection: SelectItem[]) => {
            setRightSel(selection)
            selected('right', selection)
        },
        [selected]
    )
    const handleLeftSort = useCallback((sort: Sort) => sorted('left', sort), [sorted])
    const handleRightSort = useCallback((sort: Sort) => sorted('right', sort), [sorted])
    const handleLeftScroll = useCallback((top: number) => scrolled('left', top), [scrolled])
    const handleRightScroll = useCallback((top: number) => scrolled('right', top), [scrolled])

    const [compareOpen, setCompareOpen] = useState(false)
    const compareDisabledReason = [leftLoc, rightLoc].every(
        (loc) => loc && panelFolder(loc.remote, loc.path) !== null
    )
        ? undefined
        : t`Open a folder in both panels to compare.`

    const renameSel = leftSel.length > 0 ? leftSel : rightSel
    const renameInFavorites =
        renameSel.length > 0 && (leftSel.length > 0 ? leftLoc : rightLoc)?.remote === 'UI_FAVORITES'
    const renameDisabledReason =
        leftSel.length > 0 && rightSel.length > 0
            ? t`Select items in only one panel to batch rename.`
            : renameInFavorites
              ? t`Batch rename works in a folder, not in Favorites.`
              : renameSel.length < 2
                ? t`Select at least 2 items in one panel to batch rename.`
                : undefined
    const [batchRenameOpen, setBatchRenameOpen] = useState(false)
    const [batchRenameItems, setBatchRenameItems] = useState<SelectItem[]>([])
    const handleOpenBatchRename = useCallback(() => {
        setBatchRenameItems(renameSel)
        setBatchRenameOpen(true)
        track('batch_rename_opened', { items: renameSel.length })
    }, [renameSel])

    const handleBatchRenameDone = useCallback(
        (transferId: string | undefined) => {
            if (transferId) handleJobStarted(transferId)
            for (const ref of [leftPanelRef, rightPanelRef]) ref.current?.clearSelection()
        },
        [handleJobStarted]
    )
    const closeBatchRename = useCallback(() => setBatchRenameOpen(false), [])

    const handleDrop = useCallback((items: SelectItem[], destination: string) => {
        setDropOperation({ items, destination })
    }, [])

    const handleDownload = useCallback(
        async (entry: Entry) => {
            const savePath = await save({
                title: entry.isDir ? t`Save Folder` : t`Save File`,
                defaultPath: entry.name,
            })
            if (!savePath) return
            try {
                const id = await startTransfer(
                    formOf('save', { source: entry.fullPath, destination: savePath }),
                    { origin: 'commander' }
                )
                handleJobStarted(id)
            } catch (error) {
                const recorded = coreError(error)?.transfer
                if (recorded) handleJobStarted(recorded.id)
                await reportError(error, { title: t`Error`, fallback: t`Download failed` })
            }
        },
        [handleJobStarted]
    )

    const deselect = useCallback((paths: string[]) => {
        for (const ref of [leftPanelRef, rightPanelRef]) ref.current?.deselect(paths)
    }, [])

    const { rename: handleRename, remove: handleDelete } = useEntryActions(
        useCallback((entry: Entry) => deselect([entry.key]), [deselect]),
        { onTransfer: handleJobStarted }
    )
    const handleMoved = useCallback(
        (items: SelectItem[]) => deselect(items.map((item) => item.path)),
        [deselect]
    )

    const handleShare = useCallback(async (entry: Entry) => {
        try {
            const link = await publicLink(entry.fullPath)
            if (link) {
                await clipboard.setText(link)
                const name = entry.name
                toastSuccess(t`Link Copied`, t`Public link for "${name}" copied to clipboard`)
            }
        } catch (error) {
            await reportError(error, {
                title: t`Share Error`,
                fallback: t`Failed to generate public link`,
            })
        }
    }, [])

    const [active, setActive] = useState<Side>('left')

    const diskUsage = useDiskUsage()
    const [diskUsageOpen, setDiskUsageOpen] = useState(false)
    const [usageSide, setUsageSide] = useState<Side>('left')
    const leftFrom = leftLoc ? panelFolder(leftLoc.remote, leftLoc.path) : null
    const rightFrom = rightLoc ? panelFolder(rightLoc.remote, rightLoc.path) : null
    const handleOpenDiskUsage = useCallback(
        (side: Side) => {
            const from = side === 'left' ? leftFrom : rightFrom
            if (from === null) return
            setUsageSide(side)
            diskUsage.open(from)
            setDiskUsageOpen(true)
            track('disk_usage_opened', {
                local: (side === 'left' ? leftLoc : rightLoc)?.remote === 'UI_LOCAL_FS',
            })
        },
        [diskUsage.open, leftFrom, rightFrom, leftLoc, rightLoc]
    )

    const handleMount = useCallback((from: string) => {
        openWindow(`/mount?initialSource=${encodeURIComponent(from)}`).catch((error: unknown) =>
            reportError(error, { title: t`Window not opened` })
        )
    }, [])
    const deleting = useRef(new Map<string, UsageItem>())
    const { forget } = diskUsage
    const { remove: removeFromUsage } = useEntryActions(
        useCallback(
            (entry: Entry) => {
                deselect([entry.key])
                const item = deleting.current.get(entry.key)
                if (item && !item.isDir) forget(item.rel, false)
            },
            [deselect, forget]
        ),
        {
            onTransfer: useCallback(
                (id: string, entry: Entry) => {
                    handleJobStarted(id)
                    const item = deleting.current.get(entry.key)
                    if (!item) return
                    onTransferEnd(id, (state) => {
                        if (state === 'completed') forget(item.rel, true)
                    })
                },
                [handleJobStarted, forget]
            ),
        }
    )
    const diskUsageActions: DiskUsageActions = useMemo(
        () => ({
            onShow: (path: string) =>
                (usageSide === 'left' ? leftPanelRef : rightPanelRef).current?.openPath(path),
            onDelete: (item: UsageItem) => {
                deleting.current.set(item.path, item)
                removeFromUsage({
                    key: item.path,
                    name: item.name,
                    isDir: item.isDir,
                    fullPath: item.path,
                }).finally(() => deleting.current.delete(item.path))
            },
            onStop: diskUsage.stop,
            onRescan: diskUsage.rescan,
            onLost: diskUsage.lost,
        }),
        [usageSide, removeFromUsage, diskUsage.stop, diskUsage.rescan, diskUsage.lost]
    )

    usePeekKey()

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
            if (e.key === 'r') {
                e.preventDefault()
                refreshPanels()
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                ;(active === 'left' ? leftPanelRef : rightPanelRef).current?.navigateUp()
            } else if (e.key === 'f') {
                e.preventDefault()
                ;(active === 'left' ? leftPanelRef : rightPanelRef).current?.focusSearch()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [refreshPanels, active])

    const mod = platform() === 'macos' ? '⌘' : 'Ctrl+'
    const keys = { back: `${mod}↑`, refresh: `${mod}R`, search: `${mod}F` }

    const panel = (side: Side) => {
        const from = side === 'left' ? leftFrom : rightFrom
        const onRemote = remoteOf(side === 'left' ? leftLoc : rightLoc) !== null
        return (
            <div
                className="h-full"
                onPointerDownCapture={() => setActive(side)}
                onFocusCapture={() => setActive(side)}
            >
                <FilePanel
                    ref={side === 'left' ? leftPanelRef : rightPanelRef}
                    sidebarPosition={side}
                    initialRemote={opening[side].place?.remote}
                    initialPath={opening[side].place?.path}
                    startAtFirstRemote={side === 'right'}
                    restore={opening[side].restore}
                    onSortChange={side === 'left' ? handleLeftSort : handleRightSort}
                    onScrollTopChange={side === 'left' ? handleLeftScroll : handleRightScroll}
                    selectionMode="both"
                    allowFiles={true}
                    allowMultiple={true}
                    onSelectionChange={side === 'left' ? handleLeftSelection : handleRightSelection}
                    onNavigate={side === 'left' ? handleLeftNavigate : handleRightNavigate}
                    onDrop={handleDrop}
                    onDownload={handleDownload}
                    onShare={handleShare}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onMount={from !== null && onRemote ? () => handleMount(from) : undefined}
                    onDiskUsage={from === null ? undefined : () => handleOpenDiskUsage(side)}
                    allowedKeys={['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES']}
                    isActive={true}
                    isFocused={active === side}
                    keys={keys}
                    className={side === 'left' ? 'pr-0' : 'pl-0'}
                />
            </div>
        )
    }

    return (
        <div className="flex flex-col w-screen h-screen overflow-hidden">
            <Group orientation="horizontal" className="flex-1 min-h-0">
                <Panel defaultSize={50} minSize={25}>
                    {panel('left')}
                </Panel>
                <Separator className="relative w-4 group/split outline-hidden">
                    <span
                        aria-hidden={true}
                        className={cn(
                            'absolute w-1 h-10 -translate-x-1/2 -translate-y-1/2 rounded-full left-1/2 top-1/2',
                            'bg-default-300 opacity-0 transition-[opacity,background-color,height] duration-150',
                            'group-data-[separator=hover]/split:opacity-100 group-data-[separator=focus]/split:opacity-100',
                            'group-data-[separator=active]/split:opacity-100 group-data-[separator=active]/split:bg-primary group-data-[separator=active]/split:h-16',
                            'group-data-[separator=focus]/split:bg-primary'
                        )}
                    />
                </Separator>
                <Panel defaultSize={50} minSize={25}>
                    {panel('right')}
                </Panel>
            </Group>

            <TransfersBar
                trackedIds={trackedIds}
                isExpanded={memory.barOpen}
                onExpandedChange={memory.setBarOpen}
                onOpenCompare={() => {
                    setCompareOpen(true)
                    track('compare_opened', {})
                }}
                compareDisabledReason={compareDisabledReason}
                onOpenBatchRename={handleOpenBatchRename}
                renameDisabledReason={renameDisabledReason}
                renameCount={renameSel.length}
            />

            <CompareDrawer
                isOpen={compareOpen}
                left={leftLoc}
                right={rightLoc}
                onClose={() => setCompareOpen(false)}
            />

            <DiskUsageDrawer
                isOpen={diskUsageOpen}
                scan={diskUsage.scan}
                actions={diskUsageActions}
                onClose={() => setDiskUsageOpen(false)}
            />

            <BatchRenameDrawer
                isOpen={batchRenameOpen}
                items={batchRenameItems}
                onClose={closeBatchRename}
                onDone={handleBatchRenameDone}
            />

            <OperationDialog
                items={dropOperation?.items ?? null}
                destination={dropOperation?.destination ?? null}
                onClose={() => setDropOperation(null)}
                onJobStarted={handleJobStarted}
                onMoved={handleMoved}
            />

            <Intro />
        </div>
    )
}
