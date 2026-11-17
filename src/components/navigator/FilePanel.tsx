import { Button, Checkbox, Divider, Tooltip } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronUpIcon, FolderPlusIcon } from 'lucide-react'
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    forwardRef,
    startTransition,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react'
import { fsInfoQueryOptions, hasFeature } from '../../../lib/hooks'
import { useHostStore } from '../../../store/host.ts'
import FileList from './FileList'
import PanelToolbar, { type ToolbarButtons } from './PanelToolbar'
import PathBreadcrumb from './PathBreadcrumb'
import RemoteSidebar from './RemoteSidebar'
import PreviewDrawer from './preview/PreviewDrawer'
import type { AllowedKey, ContextMenuItem, Entry, FilePanelHandle, SelectItem } from './types'
import useCreateFolder from './useCreateFolder'
import useFileNavigation from './useFileNavigation'
import { RE_LEADING_SLASH, dragStateRef, dropTargetsRef, serializeRemotePath } from './utils'

export type { FilePanelHandle } from './types'

const MIN_NAME_WIDTH = 96
const MAX_NAME_WIDTH = 1200
const clampNameWidth = (width: number) => Math.min(MAX_NAME_WIDTH, Math.max(MIN_NAME_WIDTH, width))
const measuredWidth = (cell: HTMLDivElement | null) =>
    cell?.getBoundingClientRect().width ?? MIN_NAME_WIDTH

// The columns either side of Name: checkbox 2.5rem, Size 6rem, Modified 9rem, and the actions
// column (11rem with the preview/actions column, 2.5rem without).
const fixedRem = (showPreviewColumn: boolean) => 2.5 + 6 + 9 + (showPreviewColumn ? 11 : 2.5)

// Finder-style width for the Name column: the header's right edge is dragged; the other columns
// keep their size and shift right (the list then scrolls horizontally), so a long name can be
// read without giving up Size/Modified. Double-clicking the edge restores the automatic (fill)
// width; with the edge focused, the arrow keys nudge it. Local to the panel — not persisted.
function useNameColumnResize(showPreviewColumn: boolean) {
    const [nameWidth, setNameWidth] = useState<number | null>(null)
    const nameCellRef = useRef<HTMLDivElement>(null)

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = measuredWidth(nameCellRef.current)
        // Moves keep coming while the pointer is outside the handle (and the window); listen on
        // the window for the whole drag.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        const move = (e: PointerEvent) =>
            setNameWidth(clampNameWidth(startWidth + e.clientX - startX))
        const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
    }, [])

    const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0
        if (step === 0) return
        event.preventDefault()
        setNameWidth(clampNameWidth(measuredWidth(nameCellRef.current) + step))
    }, [])

    const reset = useCallback(() => setNameWidth(null), [])

    const name = nameWidth === null ? '1fr' : `${nameWidth}px`
    return {
        nameCellRef,
        columnTemplate: `2.5rem ${name} 6rem 9rem ${showPreviewColumn ? '11rem' : '2.5rem'}`,
        // Rows and header grow past the panel once Name is wider than the fill width.
        rowMinWidth:
            nameWidth === null
                ? undefined
                : `calc(${nameWidth}px + ${fixedRem(showPreviewColumn)}rem)`,
        handleProps: { onPointerDown, onDoubleClick: reset, onKeyDown },
    }
}

const FilePanel = forwardRef<
    FilePanelHandle,
    {
        sidebarPosition?: 'left' | 'right' | 'none'
        initialRemote?: string | 'UI_LOCAL_FS'
        initialPath?: string
        selectionMode?: 'checkbox' | 'drag' | 'both'
        allowFiles?: boolean
        allowMultiple?: boolean
        onSelectionChange?: (selected: SelectItem[]) => void
        onNavigate?: (remote: string, path: string) => void
        onDragStart?: (items: SelectItem[]) => void
        onDrop?: (items: SelectItem[], destination: string) => void
        showPreviewColumn?: boolean
        onPreviewRequest?: (item: Entry) => void
        onDownload?: (item: Entry) => void
        onShare?: (item: Entry) => void
        onRename?: (item: Entry) => void
        onDelete?: (item: Entry) => void
        contextMenuItems?: ContextMenuItem[]
        allowedKeys?: AllowedKey[]
        renderToolbar?: (buttons: ToolbarButtons) => React.ReactNode[][]
        toolbarVisible?: boolean
        isActive?: boolean
    }
>(function FilePanel(
    {
        sidebarPosition = 'left',
        initialRemote,
        initialPath,
        selectionMode = 'checkbox',
        allowFiles = true,
        allowMultiple = true,
        onSelectionChange,
        onNavigate,
        onDragStart,
        onDrop,
        showPreviewColumn = true,
        onPreviewRequest,
        onDownload,
        onShare,
        onRename,
        onDelete,
        contextMenuItems,
        allowedKeys = ['REMOTES', 'LOCAL_FS'],
        renderToolbar,
        toolbarVisible = true,
        isActive = true,
    },
    ref
) {
    const favoritePaths = useHostStore((state) => state.favoritePaths)
    const [previewItem, setPreviewItem] = useState<Entry | null>(null)
    const columns = useNameColumnResize(showPreviewColumn)

    const nav = useFileNavigation({
        initialRemote,
        initialPath,
        allowedKeys,
        allowFiles,
        allowMultiple,
        isActive,
    })

    const fsInfoQuery = useQuery({
        ...fsInfoQueryOptions(nav.selectedRemote),
        enabled: nav.isRemote,
    })

    // false while loading — matches the previous default (hide the share affordance until confirmed).
    const canShare = hasFeature(fsInfoQuery.data, 'PublicLink')

    const { canCreateFolder, createFolder } = useCreateFolder(
        nav.selectedRemote,
        nav.cwd,
        nav.refresh
    )

    const newFolderButton = useMemo(
        () =>
            canCreateFolder ? (
                <Tooltip
                    key="new-folder-tooltip"
                    content="Create a new folder in this directory"
                    size="lg"
                    color="foreground"
                >
                    <Button
                        color="primary"
                        size="sm"
                        radius="full"
                        startContent={<FolderPlusIcon className="size-4" />}
                        className="gap-1 min-w-fit"
                        onPress={createFolder}
                    >
                        NEW
                    </Button>
                </Tooltip>
            ) : null,
        [canCreateFolder, createFolder]
    )

    const listRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const panelIdRef = useRef(`panel-${Math.random().toString(36).slice(2)}`)
    const [listHeight, setListHeight] = useState(400)

    useEffect(() => {
        if (!isActive || !listRef.current) return

        const measureInitial = () => {
            if (listRef.current) {
                const height = listRef.current.getBoundingClientRect().height
                if (height > 0) {
                    startTransition(() => setListHeight(height))
                }
            }
        }
        measureInitial()
        const timeoutId = setTimeout(measureInitial, 100)

        const obs = new ResizeObserver((entries) => {
            for (const entry of entries) {
                startTransition(() => setListHeight(entry.contentRect.height))
            }
        })
        obs.observe(listRef.current)

        return () => {
            clearTimeout(timeoutId)
            obs.disconnect()
        }
    }, [isActive])

    useEffect(() => {
        if (!onDrop || !panelRef.current) return
        const panelId = panelIdRef.current
        const getDestination = () =>
            nav.selectedRemote === 'UI_LOCAL_FS'
                ? nav.cwd
                : serializeRemotePath(nav.selectedRemote as string, nav.cwd)

        dropTargetsRef.current.set(panelId, {
            element: panelRef.current,
            onDrop,
            getDestination,
        })
        return () => {
            dropTargetsRef.current.delete(panelId)
        }
    }, [onDrop, nav.selectedRemote, nav.cwd])

    // getSelection is useCallback'd on [selectedPaths], so its identity alone tracks selection
    // changes — no extra dep or suppression needed.
    useEffect(() => {
        if (onSelectionChange) {
            onSelectionChange(nav.getSelection())
        }
    }, [onSelectionChange, nav.getSelection])

    useEffect(() => {
        if (onNavigate && nav.selectedRemote) {
            onNavigate(nav.selectedRemote, nav.cwd)
        }
    }, [nav.selectedRemote, nav.cwd, onNavigate])

    useImperativeHandle(
        ref,
        () => ({
            refresh: nav.refresh,
            getSelection: nav.getSelection,
            clearSelection: nav.clearSelection,
            selectAll: nav.selectAll,
            navigate: (remote: string, path: string) => {
                nav.setSelectedRemote(remote as any)
                nav.setCwd(path)
            },
            getCurrentPath: () => ({
                remote: nav.selectedRemote,
                path: nav.cwd,
            }),
        }),
        [nav]
    )

    const handleToggleFavorite = useCallback(
        (entry: Entry, isFavorited: boolean) => {
            if (isFavorited) {
                useHostStore.setState({
                    favoritePaths: (favoritePaths || []).filter((it) => {
                        const remote = (it as any).remote as string | undefined
                        const rawPath = (it as any).path as string
                        let fullKey = rawPath
                        if (rawPath?.includes(':/')) {
                            fullKey = rawPath
                        } else if (remote && remote !== 'UI_LOCAL_FS') {
                            const rel = (rawPath || '').replace(RE_LEADING_SLASH, '')
                            fullKey = serializeRemotePath(remote, rel)
                        } else {
                            fullKey = rawPath
                        }
                        return fullKey !== entry.fullPath
                    }),
                })
            } else {
                const storedPath = entry.fullPath.includes(':/')
                    ? entry.fullPath.split(':/').slice(1).join('/')
                    : entry.fullPath
                useHostStore.setState({
                    favoritePaths: [
                        ...(favoritePaths || []),
                        {
                            remote: entry.remote!,
                            path: storedPath,
                            added: Date.now(),
                        },
                    ],
                })
            }
        },
        [favoritePaths]
    )

    const handleDragStartInternal = useCallback(
        (items: Entry[]) => {
            if (onDragStart) {
                onDragStart(
                    items.map((e) => ({ path: e.fullPath, type: e.isDir ? 'folder' : 'file' }))
                )
            }
        },
        [onDragStart]
    )

    const handleDrop = useCallback(
        (event: React.DragEvent) => {
            if (!onDrop) return
            event.preventDefault()

            let items: SelectItem[] | null = null

            const data = event.dataTransfer.getData('application/json')
            if (data) {
                try {
                    const paths = JSON.parse(data) as string[]
                    items = paths.map((p) => ({
                        path: p,
                        type: p.endsWith('/') ? 'folder' : 'file',
                    }))
                } catch {
                    // Invalid JSON data
                }
            }

            if (!items && dragStateRef.current) {
                items = dragStateRef.current
            }

            if (!items || items.length === 0) return

            const destination =
                nav.selectedRemote === 'UI_LOCAL_FS'
                    ? nav.cwd
                    : serializeRemotePath(nav.selectedRemote as string, nav.cwd)
            onDrop(items, destination)
            dragStateRef.current = null
        },
        [onDrop, nav.selectedRemote, nav.cwd]
    )

    const handleDragOver = useCallback(
        (event: React.DragEvent) => {
            if (onDrop) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
            }
        },
        [onDrop]
    )

    const handlePreviewClick = useCallback(
        (entry: Entry) => {
            if (entry.isDir) return
            if (onPreviewRequest) {
                onPreviewRequest(entry)
            } else {
                setPreviewItem(entry)
            }
        },
        [onPreviewRequest]
    )

    const showSidebar = sidebarPosition !== 'none'

    const showSelectAll =
        (selectionMode === 'checkbox' || selectionMode === 'both') && allowMultiple
    const selectableCount = nav.visibleItems.length
    const selectedVisibleCount = nav.visibleItems.filter((item) =>
        nav.selectedPaths.has(item.key)
    ).length
    const allSelected = selectableCount > 0 && selectedVisibleCount === selectableCount
    const someSelected = selectedVisibleCount > 0 && !allSelected

    return (
        <div
            ref={panelRef}
            className="flex flex-row w-full h-full"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
        >
            {showSidebar && sidebarPosition === 'left' && (
                <>
                    <RemoteSidebar
                        position="left"
                        selectedRemote={nav.selectedRemote}
                        cwd={nav.cwd}
                        onRemoteSelect={nav.selectRemote}
                        allowedKeys={allowedKeys}
                        remotes={nav.remotes}
                    />
                    <Divider orientation="vertical" />
                </>
            )}

            <div className="flex flex-col w-full h-full overflow-y-hidden ">
                <PathBreadcrumb
                    remote={nav.selectedRemote}
                    path={nav.cwd}
                    pathInput={nav.pathInput}
                    onNavigate={nav.navigateTo}
                    onPathInputChange={nav.setPathInput}
                    isReadOnly={nav.selectedRemote === 'UI_FAVORITES'}
                />
                <Divider />

                <div className="relative flex flex-col w-full h-full overflow-hidden">
                    {/* Header and list share the column template; a widened Name
                        column pushes both past the panel, and they scroll together. */}
                    <div className="flex flex-col flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
                        <div
                            className="sticky top-0 z-10 grid items-stretch bg-default-100"
                            style={{
                                gridTemplateColumns: columns.columnTemplate,
                                minWidth: columns.rowMinWidth,
                            }}
                        >
                            <div className="flex items-center justify-end">
                                {showSelectAll && (
                                    <Checkbox
                                        isSelected={allSelected}
                                        isIndeterminate={someSelected}
                                        isDisabled={selectableCount === 0}
                                        onValueChange={() =>
                                            allSelected
                                                ? nav.clearSelection()
                                                : nav.selectAll('all')
                                        }
                                        aria-label="Select all items"
                                    />
                                )}
                            </div>
                            {(
                                [
                                    { column: 'name', label: 'Name', className: 'pl-2' },
                                    { column: 'size', label: 'Size', className: '' },
                                    {
                                        column: 'modTime',
                                        label: 'Last Modified',
                                        className: '',
                                    },
                                ] as const
                            ).map(({ column, label, className }) => {
                                const isSorted = nav.sortDescriptor.column === column
                                const nextDirection =
                                    isSorted && nav.sortDescriptor.direction === 'ascending'
                                        ? 'descending'
                                        : 'ascending'
                                const sortStatus = isSorted
                                    ? `, sorted ${nav.sortDescriptor.direction}`
                                    : ''
                                return (
                                    <div
                                        key={column}
                                        ref={column === 'name' ? columns.nameCellRef : undefined}
                                        className={column === 'name' ? 'relative' : undefined}
                                    >
                                        <button
                                            type="button"
                                            className={`flex items-center w-full h-full gap-1 py-2 font-semibold text-left rounded-small text-small hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${className}`}
                                            aria-pressed={isSorted}
                                            aria-label={`${label}${sortStatus}. Activate to sort ${nextDirection}.`}
                                            onClick={() => nav.handleSort(column)}
                                        >
                                            <span>{label}</span>
                                            {isSorted &&
                                                (nav.sortDescriptor.direction === 'ascending' ? (
                                                    <ChevronUpIcon
                                                        className="size-3.5"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <ChevronDownIcon
                                                        className="size-3.5"
                                                        aria-hidden="true"
                                                    />
                                                ))}
                                        </button>
                                        {column === 'name' && (
                                            // The column's right edge: drag to widen Name,
                                            // double-click to let it fill again.
                                            <div
                                                role="separator"
                                                aria-orientation="vertical"
                                                aria-label="Resize Name column"
                                                tabIndex={0}
                                                data-column-resize="name"
                                                className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none hover:bg-primary-200 active:bg-primary-300"
                                                {...columns.handleProps}
                                            />
                                        )}
                                    </div>
                                )
                            })}
                            <div />
                        </div>

                        <div
                            ref={listRef}
                            className="relative flex-1 w-full overflow-hidden"
                            style={{ minWidth: columns.rowMinWidth }}
                        >
                            <FileList
                                columnTemplate={columns.columnTemplate}
                                items={nav.virtualizedItems}
                                isLoading={nav.isLoading || nav.isSearching}
                                error={nav.recursiveSearchActive ? nav.searchError : nav.error}
                                selectedKeys={nav.selectedPaths}
                                onToggleSelect={nav.handleToggleSelect}
                                onNavigate={nav.handleNavigate}
                                selectionMode={selectionMode}
                                allowMultiple={allowMultiple}
                                showPreviewColumn={showPreviewColumn}
                                onPreviewClick={handlePreviewClick}
                                onDownload={onDownload}
                                onShare={canShare ? onShare : undefined}
                                onRename={onRename}
                                onDelete={onDelete}
                                draggable={selectionMode === 'drag' || selectionMode === 'both'}
                                onDragStart={handleDragStartInternal}
                                // handled at the Browser level
                                onContextMenu={contextMenuItems ? () => {} : undefined}
                                favoritedKeys={nav.favoritedKeys}
                                onToggleFavorite={handleToggleFavorite}
                                listHeight={listHeight}
                            />
                        </div>
                    </div>

                    <PanelToolbar
                        onBack={nav.navigateUp}
                        onRefresh={nav.refresh}
                        isBackDisabled={nav.isUpDisabled}
                        isLoading={nav.isLoading}
                        searchTerm={nav.searchTerm}
                        onSearchChange={nav.setSearchTerm}
                        searchInSubfolders={nav.searchInSubfolders}
                        onSearchInSubfoldersChange={nav.setSearchInSubfolders}
                        renderToolbar={renderToolbar}
                        visible={toolbarVisible && nav.selectedRemote !== 'UI_FAVORITES'}
                        newFolderButton={newFolderButton}
                    />
                </div>
            </div>

            {showSidebar && sidebarPosition === 'right' && (
                <>
                    <Divider orientation="vertical" />
                    <RemoteSidebar
                        position="right"
                        selectedRemote={nav.selectedRemote}
                        cwd={nav.cwd}
                        onRemoteSelect={nav.selectRemote}
                        allowedKeys={allowedKeys}
                        remotes={nav.remotes}
                    />
                </>
            )}

            {!onPreviewRequest && (
                <PreviewDrawer item={previewItem} onClose={() => setPreviewItem(null)} />
            )}
        </div>
    )
})

export default FilePanel
