import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { coreError, reportError } from '../../../lib/errors'
import { formOf } from '../../../lib/operations'
import { clipboard, dataDir, platform, save } from '../../../lib/shell'
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
    useUsageRoot,
} from '../../components/navigator'
import type { Entry, SelectItem, Sort } from '../../components/navigator/types'
import { BY_NAME, panelFolder, placeOf } from '../../components/navigator/utils'
import { toastSuccess } from '../../components/toast'
import { usePageQuery } from '../../route'
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
import TransfersBar, { type DiskUsageChoice, useActivityTip } from './TransfersBar'

/** How long the scroll position must stay still before it is saved, in ms. */
const SAVE_SCROLL_AFTER = 250

type Side = 'left' | 'right'

/** The remote that a panel shows, or null for this computer. */
function remoteOf(loc: PanelLocation | null): string | null {
    return !loc?.remote || loc.remote === 'UI_LOCAL_FS' ? null : loc.remote
}

/**
 * Parses a place given in the route. As in rclone, `remote:dir` is on a remote, and anything else
 * is local.
 */
function parsePanelTarget(raw: string | null): Place | undefined {
    if (!raw) return undefined
    const place = placeOf(raw)
    return { remote: place.remote, path: place.cwd }
}

/**
 * Commander as it was left (`snapshot.ts`). Every change is saved at once, and the scroll position
 * once it stays still.
 */
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
    // A panel that moves to another folder starts at its top, so the kept scroll position is reset.
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

/**
 * The Commander page: two file panels for browsing remotes and local disks. The route's `?left=`
 * and `?right=` (from a deep link or the launcher) set where the panels start. Otherwise they
 * start where they were left. Without either, the left panel starts at home, and the right one
 * at the first remote's root.
 */
export default function Commander() {
    const leftPanelRef = useRef<FilePanelHandle>(null)
    const rightPanelRef = useRef<FilePanelHandle>(null)
    const memory = useSnapshot()
    const { opening, moved, sorted, selected, scrolled } = memory

    const [dropOperation, setDropOperation] = useState<{
        items: SelectItem[]
        destination: string
    } | null>(null)

    // The ids of the transfers that this page started, which its bar shows. The first transfer
    // started while the bar is closed opens a dialog that says where to follow it.
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

    // The folder and the selection of each panel, used by the Compare and Batch Rename actions.
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

    // Batch Rename needs at least 2 selected items in exactly one panel. The items are copied when
    // the drawer opens, so the drawer keeps them during its closing animation.
    const renameSel = leftSel.length > 0 ? leftSel : rightSel
    // A favorite is a bookmark. Renaming it would rename the real folder it points to.
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

    // Renamed entries have new keys, so the old selection is out of date either way. The renames
    // run as one recorded transfer, which is shown in the bar. When it ends, the folders are
    // listed again.
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

    // Saves an entry to this computer. It runs as a normal transfer (the save operation), so it
    // is listed in History and can be retried.
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

    // Removes entries that were renamed, deleted or moved away from both panels' selections.
    // Otherwise Batch Rename or a drag would send paths that no longer exist.
    const deselect = useCallback((paths: string[]) => {
        for (const ref of [leftPanelRef, rightPanelRef]) ref.current?.deselect(paths)
    }, [])

    // Rename and delete actions for a row, shared with the picker. Deleting a folder runs as a
    // transfer, which the bar shows.
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

    // The panel the user works in: the last one clicked or focused. Its selection shows in the
    // accent, and the keyboard's shortcuts act on it.
    const [active, setActive] = useState<Side>('left')

    // Disk Usage scans the whole remote, or the whole disk, of the panel that the user picks in
    // its menu. The scan belongs to the page, so it goes on while the drawer is closed and shows
    // again when it opens. "Show in panel" opens a folder in the panel that the scan came from.
    const diskUsage = useDiskUsage()
    const [diskUsageOpen, setDiskUsageOpen] = useState(false)
    const [usageSide, setUsageSide] = useState<Side>('left')
    const leftFrom = leftLoc ? panelFolder(leftLoc.remote, leftLoc.path) : null
    const rightFrom = rightLoc ? panelFolder(rightLoc.remote, rightLoc.path) : null
    const leftRoot = useUsageRoot(leftFrom)
    const rightRoot = useUsageRoot(rightFrom)
    const diskUsageChoices: DiskUsageChoice[] = [
        { side: 'left', from: leftFrom, root: leftRoot, remote: remoteOf(leftLoc) },
        { side: 'right', from: rightFrom, root: rightRoot, remote: remoteOf(rightLoc) },
    ]
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
    // A deleted file leaves the scan at once. A folder is deleted by a recorded transfer, which the
    // bar shows, and leaves the scan when the transfer completes. Each delete is remembered by its
    // path until it is done, because a second one can start before the first ends.
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

    // ⌘R lists both panels' folders again. ⌘↑ opens the active panel's parent folder, and ⌘F puts
    // the focus in its search field.
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

    const panel = (side: Side) => (
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
                allowedKeys={['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES']}
                isActive={true}
                isFocused={active === side}
                keys={keys}
                // The gap between the panels is the splitter's.
                className={side === 'left' ? 'pr-0' : 'pl-0'}
            />
        </div>
    )

    return (
        <div className="flex flex-col w-screen h-screen overflow-hidden">
            <Group orientation="horizontal" className="flex-1 min-h-0">
                <Panel defaultSize={50} minSize={25}>
                    {panel('left')}
                </Panel>
                <Separator className="relative w-4 group/split outline-hidden">
                    {/* A grip that shows while the splitter is hovered, dragged or focused. */}
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
                diskUsageChoices={diskUsageChoices}
                onOpenDiskUsage={handleOpenDiskUsage}
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
        </div>
    )
}
