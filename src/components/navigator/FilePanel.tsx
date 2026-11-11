import { Button, Checkbox, cn, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleDownSmall as AngleDownSmallIcon,
    AngleUpSmall as AngleUpSmallIcon,
    FolderArrowDown as FolderArrowDownIcon,
    Folder as FolderIcon,
    FolderPlus as FolderPlusIcon,
    Search as SearchIcon,
    Star as StarIcon,
    XmarkCircle as XmarkCircleIcon,
} from '@zappicon/react'
import {
    type CSSProperties,
    forwardRef,
    type DragEvent as ReactDragEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    startTransition,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react'
import { reportError } from '../../../lib/errors'
import { formatBytes } from '../../../lib/format'
import { baseName, configNameOf } from '../../../lib/paths'
import { hasFeature, useFsInfo, useRemoteHealth } from '../../../lib/remotes'
import { IconTile } from '../look/IconTile'
import { SURFACE } from '../look/Panel'
import { StatusDot } from '../look/Status'
import { ToneProgress } from '../look/ToneProgress'
import { landsOnItself } from './drops'
import FileList, { type EmptyListing, ROW_GRID, ROWS_MIN_WIDTH } from './FileList'
import { useToggleFavorite } from './favorites'
import PanelToolbar, {
    BackButton,
    RefreshButton,
    SearchField,
    TIP,
    type ToolbarButtons,
} from './PanelToolbar'
import PathBreadcrumb from './PathBreadcrumb'
import PreviewDrawer from './preview/PreviewDrawer'
import RemoteSidebar from './RemoteSidebar'
import type { AllowedKey, Entry, FilePanelHandle, SelectItem, Sort } from './types'
import useCreateFolder from './useCreateFolder'
import useFileNavigation, { type PanelStatus } from './useFileNavigation'
import { dragStateRef, panelFolder } from './utils'

export type { FilePanelHandle } from './types'

/** How a panel was left at its initial place: its sort, selection and scroll position. */
export interface PanelRestore {
    sort: Sort
    selection: SelectItem[]
    scrollTop: number
}

/** The keyboard shortcuts that the page gives a panel's controls, shown in their tooltips. */
export interface PanelKeys {
    back?: string
    refresh?: string
    search?: string
}

const MIN_NAME_WIDTH = 96
const MAX_NAME_WIDTH = 1200
const clampNameWidth = (width: number) => Math.min(MAX_NAME_WIDTH, Math.max(MIN_NAME_WIDTH, width))
const measuredWidth = (cell: HTMLDivElement | null) =>
    cell?.getBoundingClientRect().width ?? MIN_NAME_WIDTH

// The widths of the columns around Name: checkbox 2.25rem, Size 6rem, Modified 8.5rem, and a
// margin of 0.75rem. Name takes the 1fr. A row's actions show over its Size and Modified.
const FIXED_REM = 2.25 + 6 + 8.5 + 0.75

// A Finder-style resizable Name column. Dragging the right edge of its header widens it. The
// other columns keep their size and move right, and the list scrolls horizontally, so a long
// name can be read without hiding Size and Modified. Double-clicking the edge restores the
// automatic width that fills the panel, and the arrow keys adjust it while the edge has focus.
// The width belongs to the panel and isn't saved.
function useNameColumnResize() {
    const [nameWidth, setNameWidth] = useState<number | null>(null)
    const nameCellRef = useRef<HTMLDivElement>(null)

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = measuredWidth(nameCellRef.current)
        // The pointer leaves the handle (and maybe the window) during a drag. Capture it and
        // listen on the window, so that its moves keep arriving.
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

    // Fill the panel, but never get too narrow to read a name. A narrow panel scrolls sideways
    // instead.
    const name = nameWidth === null ? `minmax(${MIN_NAME_WIDTH}px, 1fr)` : `${nameWidth}px`
    return {
        nameCellRef,
        // A narrow panel leaves Modified out (`compactTemplate`), so names keep room to be read.
        columnTemplate: `2.25rem ${name} 6rem 8.5rem 0.75rem`,
        compactTemplate: `2.25rem ${name} 5.5rem 0.75rem`,
        // The rows and header grow wider than the panel once Name is wider than the fill width.
        rowMinWidth: `calc(${nameWidth ?? MIN_NAME_WIDTH}px + ${FIXED_REM}rem)`,
        compactMinWidth: `calc(${nameWidth ?? MIN_NAME_WIDTH}px + ${2.25 + 5.5 + 0.75}rem)`,
        // The width Name was given, or null while it fills the panel.
        nameWidth,
        handleProps: { onPointerDown, onDoubleClick: reset, onKeyDown },
    }
}

/** Whether rows dragged over the panel would be accepted, refused, or nothing is dragged. */
type DropState = 'none' | 'accept' | 'refuse'

const COLUMNS = [
    {
        column: 'name',
        label: t({ message: 'Name', comment: 'The name of a file.' }),
        className: 'pl-2.5',
    },
    {
        column: 'size',
        label: t({ message: 'Size', comment: 'The size of a file.' }),
        className: 'justify-end pr-3',
    },
    { column: 'modTime', label: t`Last Modified`, className: '@max-lg:hidden' },
] as const

/**
 * What a screen reader says for a column's header button: the column, how the list is sorted by
 * it (`sorted` is null when it isn't), and what pressing the button does.
 */
function sortLabel(column: string, sorted: Sort['direction'] | null): string {
    switch (sorted) {
        case 'ascending':
            return t({
                message: `${column}, sorted ascending. Activate to sort descending.`,
                comment: 'A column header for a screen reader. {column} is its name, such as Size.',
            })
        case 'descending':
            return t({
                message: `${column}, sorted descending. Activate to sort ascending.`,
                comment: 'A column header for a screen reader. {column} is its name, such as Size.',
            })
        default:
            return t({
                message: `${column}. Activate to sort ascending.`,
                comment: 'A column header for a screen reader. {column} is its name, such as Size.',
            })
    }
}

const FilePanel = forwardRef<
    FilePanelHandle,
    {
        sidebarPosition?: 'left' | 'right'
        initialRemote?: string | 'UI_LOCAL_FS'
        initialPath?: string
        /** Without an initial place, start at the first remote's root (or at home without one). */
        startAtFirstRemote?: boolean
        /** How the panel was left at its initial place. It is read once. */
        restore?: PanelRestore
        onSortChange?: (sort: Sort) => void
        onScrollTopChange?: (scrollTop: number) => void
        /** `both` also lets rows be dragged onto a panel. */
        selectionMode?: 'checkbox' | 'both'
        allowFiles?: boolean
        allowMultiple?: boolean
        onSelectionChange?: (selected: SelectItem[]) => void
        onNavigate?: (remote: string, path: string) => void
        /**
         * Called with the rows dropped on the panel and the folder it shows. Only a folder accepts
         * a drop, and never one that would put a row onto itself (`landsOnItself`).
         */
        onDrop?: (items: SelectItem[], destination: string) => void
        onDownload?: (item: Entry) => void
        onShare?: (item: Entry) => void
        onRename?: (item: Entry) => void
        onDelete?: (item: Entry) => void
        allowedKeys?: AllowedKey[]
        /**
         * Arranges the panel's buttons, with the page's own, in a toolbar that floats over the
         * bottom of the list (the path picker's). Without it, the buttons are in the panel's header.
         */
        renderToolbar?: (buttons: ToolbarButtons) => ReactNode[][]
        toolbarVisible?: boolean
        isActive?: boolean
        /**
         * Whether this is the page's active panel, of two. It is outlined, and its selection is in
         * the accent while the other panel's turns grey. Leave it out for a page's only panel.
         */
        isFocused?: boolean
        keys?: PanelKeys
        className?: string
    }
>(function FilePanel(
    {
        sidebarPosition = 'left',
        initialRemote,
        initialPath,
        startAtFirstRemote,
        restore,
        onSortChange,
        onScrollTopChange,
        selectionMode = 'checkbox',
        allowFiles = true,
        allowMultiple = true,
        onSelectionChange,
        onNavigate,
        onDrop,
        onDownload,
        onShare,
        onRename,
        onDelete,
        allowedKeys = ['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA'],
        renderToolbar,
        toolbarVisible = true,
        isActive = true,
        isFocused,
        keys,
        className,
    },
    ref
) {
    const [previewItem, setPreviewItem] = useState<Entry | null>(null)
    const columns = useNameColumnResize()

    // Read once, because a restore is for the panel's first place.
    const [restored] = useState(restore)
    const nav = useFileNavigation({
        initialRemote,
        initialPath,
        startAtFirstRemote,
        initialSort: restored?.sort,
        initialSelection: restored?.selection,
        allowedKeys,
        allowFiles,
        allowMultiple,
        isActive,
    })

    // The remote's cached fsinfo from the shared remotes list, looked up by config name. Sharing
    // stays hidden until fsinfo confirms that the remote supports public links.
    const fsInfo = useFsInfo(nav.isRemote ? configNameOf(nav.selectedRemote as string) : null)
    const canShare = hasFeature(fsInfo.data, 'PublicLink')

    // Favorites are bookmarks, not a folder being listed. A row points to a path rather than
    // being one, so rename, download and delete would act on the real file or folder. The only
    // action a favorite row offers is removing the bookmark.
    const isFavorites = nav.selectedRemote === 'UI_FAVORITES'

    const { canCreateFolder, createFolder } = useCreateFolder(nav.selectedRemote, nav.cwd)

    // The controls sit in the panel's header, unless the page floats them in a toolbar of its own.
    const inHeader = !renderToolbar
    const showControls = toolbarVisible && !isFavorites

    const newFolderButton = useMemo(
        () =>
            canCreateFolder ? (
                <Tooltip
                    key="new-folder-tooltip"
                    content={t`Create a new folder here`}
                    {...TIP}
                    closeDelay={0}
                >
                    {inHeader ? (
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            radius="md"
                            aria-label={t`New folder`}
                            className="shrink-0 text-default-600"
                            onPress={createFolder}
                        >
                            <FolderPlusIcon className="size-[18px]" />
                        </Button>
                    ) : (
                        <Button
                            color="primary"
                            size="sm"
                            radius="full"
                            startContent={<FolderPlusIcon className="size-4" />}
                            className="gap-1 pl-2.5 pr-3 font-semibold tracking-wide min-w-fit text-[11px]"
                            onPress={createFolder}
                        >
                            {t({
                                message: 'NEW',
                                comment: 'Button: creates a new folder. Short, in capitals.',
                            })}
                        </Button>
                    )}
                </Tooltip>
            ) : null,
        [canCreateFolder, createFolder, inHeader]
    )

    const listRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)
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

    // getSelection is memoized on the selection, so its identity changes only when the
    // selection does. No other dependency is needed.
    useEffect(() => {
        if (onSelectionChange) {
            onSelectionChange(nav.getSelection())
        }
    }, [onSelectionChange, nav.getSelection])

    useEffect(() => {
        onSortChange?.(nav.sortDescriptor)
    }, [nav.sortDescriptor, onSortChange])

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
            deselect: nav.deselect,
            selectAll: nav.selectAll,
            getCurrentPath: () => ({
                remote: nav.selectedRemote,
                path: nav.cwd,
            }),
            navigateUp: () => {
                if (!nav.isUpDisabled && !nav.isLoading) nav.navigateUp()
            },
            focusSearch: () => searchRef.current?.focus(),
            openPath: nav.navigateTo,
        }),
        [nav]
    )

    const toggleFavorite = useToggleFavorite()
    const handleToggleFavorite = useCallback(
        (entry: Entry, isFavorited: boolean) => {
            // A favorite is the full path, written exactly as the panel has it, without adding
            // or removing a slash.
            toggleFavorite(entry.fullPath, !isFavorited).catch((error: unknown) =>
                reportError(error, {
                    title: t`Favorites`,
                    fallback: t`Could not save`,
                })
            )
        },
        [toggleFavorite]
    )

    // A drop goes into the folder shown, in the form the core expects. Favorites, a panel with no
    // remote yet, and the list of disks aren't folders, so they don't accept drops, and the
    // cursor shows that.
    const destination = panelFolder(nav.selectedRemote, nav.cwd)

    // While rows from this app are dragged over the panel, it shows where they would land, or
    // that they can't land here.
    const [dropState, setDropState] = useState<DropState>('none')
    useEffect(() => {
        if (dropState === 'none') return
        const clear = () => setDropState('none')
        window.addEventListener('dragend', clear)
        window.addEventListener('drop', clear)
        return () => {
            window.removeEventListener('dragend', clear)
            window.removeEventListener('drop', clear)
        }
    }, [dropState])

    const handleDrop = useCallback(
        (event: ReactDragEvent) => {
            setDropState('none')
            if (!onDrop || destination === null) return
            event.preventDefault()

            let items: SelectItem[] | null = null

            const data = event.dataTransfer.getData('application/json')
            if (data) {
                try {
                    const parsed = JSON.parse(data) as (string | SelectItem)[]
                    items = parsed.map((p) =>
                        typeof p === 'string'
                            ? { path: p, type: p.endsWith('/') ? 'folder' : 'file' }
                            : p
                    )
                } catch {
                    // Invalid JSON data
                }
            }

            if (!items && dragStateRef.current) {
                items = dragStateRef.current
            }

            // Rows dropped onto themselves start nothing. Rows dragged from another window can
            // only be checked here, because the cursor couldn't refuse them during the drag.
            if (!items || items.length === 0 || landsOnItself(items, destination)) return

            onDrop(items, destination)
            dragStateRef.current = null
        },
        [onDrop, destination]
    )

    // Rows dragged onto themselves (their own folder, one of the rows, or a folder inside one)
    // are refused, and the cursor shows it. dragover fires many times a second, so the result is
    // cached for the dragged rows and this folder.
    const refusal = useRef({ items: null as SelectItem[] | null, destination: '', refused: false })
    const handleDragOver = useCallback(
        (event: ReactDragEvent) => {
            if (!onDrop || destination === null) return
            event.preventDefault()
            const items = dragStateRef.current
            const last = refusal.current
            if (items !== last.items || destination !== last.destination) {
                const refused = !!items && landsOnItself(items, destination)
                refusal.current = { items, destination, refused }
            }
            event.dataTransfer.dropEffect = refusal.current.refused ? 'none' : 'copy'
            // Only rows of this app carry their items. Files dragged in from elsewhere aren't
            // taken, so the panel doesn't offer to.
            if (items || event.dataTransfer.types.includes('application/json')) {
                setDropState(refusal.current.refused ? 'refuse' : 'accept')
            }
        },
        [onDrop, destination]
    )
    const handleDragLeave = useCallback((event: ReactDragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropState('none')
    }, [])

    const handlePreviewClick = useCallback((entry: Entry) => {
        if (!entry.isDir) setPreviewItem(entry)
    }, [])

    const selectable = allowFiles ? nav.visibleItems : nav.visibleItems.filter((item) => item.isDir)
    const selectableCount = selectable.length
    const selectedVisibleCount = selectable.filter((item) => nav.selectedPaths.has(item.key)).length
    const allSelected = selectableCount > 0 && selectedVisibleCount === selectableCount
    const someSelected = selectedVisibleCount > 0 && !allSelected

    const term = nav.searchTerm.trim()
    const empty: EmptyListing = nav.selectedRemote
        ? isFavorites
            ? {
                  icon: StarIcon,
                  tone: 'orange',
                  title: t`No favorites yet`,
                  description: t`Hover a folder and press the star button to add it here.`,
              }
            : term
              ? {
                    icon: SearchIcon,
                    tone: 'graphite',
                    title: t`No matches`,
                    description: nav.searchInSubfolders
                        ? t`Nothing named “${term}” in this folder or its sub-folders.`
                        : t`Nothing here is named “${term}”. Search in sub-folders to look deeper.`,
                }
              : {
                    icon: FolderIcon,
                    tone: 'blue',
                    title: t`This folder is empty`,
                    description: onDrop
                        ? t`Drag files here from the other panel, or create a folder.`
                        : undefined,
                    action: canCreateFolder ? (
                        <Button
                            size="sm"
                            variant="flat"
                            startContent={<FolderPlusIcon className="size-4" />}
                            onPress={createFolder}
                        >
                            <Trans>New folder</Trans>
                        </Button>
                    ) : undefined,
                }
        : {
              icon: FolderIcon,
              tone: 'blue',
              title: t`Choose a place`,
              description: t`Pick a remote, a disk or a folder in the sidebar.`,
          }

    const folderName =
        nav.selectedRemote === 'UI_LOCAL_FS'
            ? baseName(nav.cwd) || nav.cwd
            : baseName(nav.cwd) || configNameOf(nav.selectedRemote ?? '')

    const sidebar = (
        <RemoteSidebar
            position={sidebarPosition}
            selectedRemote={nav.selectedRemote}
            cwd={nav.cwd}
            onRemoteSelect={nav.selectRemote}
            allowedKeys={allowedKeys}
            remotes={nav.remotes}
        />
    )

    return (
        <div
            className={cn('flex flex-row w-full h-full gap-2 p-2', className)}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            {sidebarPosition === 'left' && sidebar}

            <section
                aria-label={sidebarPosition === 'left' ? t`Left panel` : t`Right panel`}
                data-focused={isFocused !== false}
                // The header and the rows read their columns from here (FileList's ROW_GRID).
                style={
                    {
                        '--file-columns': columns.columnTemplate,
                        '--file-columns-compact': columns.compactTemplate,
                        '--rows-min': columns.rowMinWidth,
                        '--rows-min-compact': columns.compactMinWidth,
                    } as CSSProperties
                }
                className={cn(
                    'group/panel @container relative flex flex-col flex-1 min-w-0 h-full overflow-hidden',
                    SURFACE,
                    'transition-[box-shadow] duration-150',
                    isFocused &&
                        'shadow-[0_0_0_1px_rgb(0_111_238/0.45),0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-6px_rgb(0_111_238/0.18)] dark:shadow-[0_0_0_1px_rgb(56_189_248/0.4),0_8px_24px_-6px_rgb(0_0_0/0.6)]'
                )}
            >
                <header className="flex items-center gap-1 px-2 border-b h-11 shrink-0 border-divider">
                    {inHeader && showControls && (
                        <>
                            <BackButton
                                onBack={nav.navigateUp}
                                isDisabled={nav.isUpDisabled || nav.isLoading}
                                placement="header"
                                keys={keys?.back}
                            />
                            <RefreshButton
                                onRefresh={nav.refresh}
                                isDisabled={nav.isLoading || nav.isRefreshing}
                                isSpinning={nav.isLoading || nav.isRefreshing}
                                placement="header"
                                keys={keys?.refresh}
                            />
                        </>
                    )}
                    <PathBreadcrumb
                        remote={nav.selectedRemote}
                        path={nav.cwd}
                        pathInput={nav.pathInput}
                        onNavigate={nav.navigateTo}
                        onPathInputChange={nav.setPathInput}
                        isReadOnly={isFavorites}
                        className="flex-1"
                    />
                    {inHeader && showControls && (
                        <>
                            <SearchField
                                searchTerm={nav.searchTerm}
                                onSearchChange={nav.setSearchTerm}
                                searchInSubfolders={nav.searchInSubfolders}
                                onSearchInSubfoldersChange={nav.setSearchInSubfolders}
                                placement="header"
                                inputRef={searchRef}
                            />
                            {newFolderButton}
                        </>
                    )}
                </header>

                <div className="relative flex flex-col flex-1 w-full min-h-0 overflow-hidden">
                    {/* The header and list share the column template. A widened Name
                        column pushes both past the edge of the panel, and they scroll together. */}
                    <div className="flex flex-col flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
                        {/* The rows are inset by 6 px on each side, and the header with them. */}
                        <div
                            className={cn(
                                'sticky top-0 z-10 grid items-stretch h-8 px-1.5 border-b shrink-0 border-divider box-content',
                                ROW_GRID,
                                ROWS_MIN_WIDTH
                            )}
                        >
                            <div className="flex items-center justify-end">
                                {allowMultiple && (
                                    <Checkbox
                                        size="sm"
                                        isSelected={allSelected}
                                        isIndeterminate={someSelected}
                                        isDisabled={selectableCount === 0}
                                        onValueChange={() =>
                                            allSelected
                                                ? nav.clearSelection()
                                                : nav.selectAll('all')
                                        }
                                        aria-label={t`Select all items`}
                                        classNames={{ wrapper: 'me-0' }}
                                    />
                                )}
                            </div>
                            {COLUMNS.map(({ column, label, className: cell }) => {
                                const isSorted = nav.sortDescriptor.column === column
                                return (
                                    <div
                                        key={column}
                                        ref={column === 'name' ? columns.nameCellRef : undefined}
                                        className={cn(
                                            'relative',
                                            column === 'modTime' && '@max-lg:hidden'
                                        )}
                                    >
                                        <button
                                            type="button"
                                            className={cn(
                                                'flex items-center w-full h-full gap-1 text-xs font-medium text-left outline-hidden',
                                                'transition-colors duration-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary rounded-md',
                                                isSorted ? 'text-foreground' : 'text-default-500',
                                                cell
                                            )}
                                            aria-pressed={isSorted}
                                            aria-label={sortLabel(
                                                label,
                                                isSorted ? nav.sortDescriptor.direction : null
                                            )}
                                            onClick={() => nav.handleSort(column)}
                                        >
                                            <span>{label}</span>
                                            {isSorted &&
                                                (nav.sortDescriptor.direction === 'ascending' ? (
                                                    <AngleUpSmallIcon
                                                        className="size-3.5 text-primary"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <AngleDownSmallIcon
                                                        className="size-3.5 text-primary"
                                                        aria-hidden="true"
                                                    />
                                                ))}
                                        </button>
                                        {column === 'name' && (
                                            // The right edge of the column. Drag it to widen
                                            // Name, or double-click it to fill the panel again.
                                            // biome-ignore lint/a11y/useSemanticElements: a splitter that takes focus and pointer drags, which an <hr> isn't for.
                                            <div
                                                role="separator"
                                                aria-orientation="vertical"
                                                aria-label={t`Resize Name column`}
                                                // A splitter that the arrow keys move reports Name's width.
                                                aria-valuemin={MIN_NAME_WIDTH}
                                                aria-valuemax={MAX_NAME_WIDTH}
                                                aria-valuenow={columns.nameWidth ?? MIN_NAME_WIDTH}
                                                aria-valuetext={
                                                    columns.nameWidth === null
                                                        ? t`Fills the panel`
                                                        : plural(columns.nameWidth, {
                                                              one: '# pixel',
                                                              other: '# pixels',
                                                          })
                                                }
                                                tabIndex={0}
                                                data-column-resize="name"
                                                className={cn(
                                                    'absolute inset-y-0 z-10 w-2 -right-1 cursor-col-resize touch-none rounded-full outline-hidden',
                                                    'after:absolute after:inset-y-2 after:left-1/2 after:w-px after:bg-divider',
                                                    'hover:after:inset-y-1 hover:after:w-0.5 hover:after:bg-primary active:after:bg-primary focus-visible:after:bg-primary focus-visible:after:w-0.5'
                                                )}
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
                            className={cn('relative flex-1 w-full overflow-hidden', ROWS_MIN_WIDTH)}
                        >
                            <FileList
                                items={nav.virtualizedItems}
                                isLoading={nav.isLoading || nav.isSearching}
                                error={nav.recursiveSearchActive ? nav.searchError : nav.error}
                                onRetry={nav.refresh}
                                empty={empty}
                                selectedKeys={nav.selectedPaths}
                                onToggleSelect={nav.handleToggleSelect}
                                onNavigate={nav.handleNavigate}
                                allowMultiple={allowMultiple}
                                foldersOnly={!allowFiles}
                                onPreviewClick={handlePreviewClick}
                                onDownload={isFavorites ? undefined : onDownload}
                                onShare={canShare ? onShare : undefined}
                                onRename={isFavorites ? undefined : onRename}
                                onDelete={isFavorites ? undefined : onDelete}
                                // A favorite row is a bookmark, so dragging it would copy or move
                                // the real folder.
                                draggable={selectionMode === 'both' && !isFavorites}
                                showFullPath={isFavorites}
                                onToggleFavorite={handleToggleFavorite}
                                listHeight={listHeight}
                                folder={`${nav.selectedRemote}\n${nav.cwd}`}
                                restoreScrollTop={restored?.scrollTop}
                                onScrollTopChange={onScrollTopChange}
                            />
                        </div>
                    </div>

                    {!inHeader && (
                        <PanelToolbar
                            onBack={nav.navigateUp}
                            onRefresh={nav.refresh}
                            isBackDisabled={nav.isUpDisabled}
                            isLoading={nav.isLoading}
                            isRefreshing={nav.isRefreshing}
                            searchTerm={nav.searchTerm}
                            onSearchChange={nav.setSearchTerm}
                            searchInSubfolders={nav.searchInSubfolders}
                            onSearchInSubfoldersChange={nav.setSearchInSubfolders}
                            renderToolbar={renderToolbar}
                            visible={showControls}
                            newFolderButton={newFolderButton}
                        />
                    )}
                </div>

                <PanelStatusBar
                    items={nav.visibleItems}
                    selectedPaths={nav.selectedPaths}
                    status={nav.status}
                    isFavorites={isFavorites}
                    isSearch={!!term}
                    remote={nav.isRemote ? configNameOf(nav.selectedRemote as string) : null}
                />

                {dropState !== 'none' && <DropHint state={dropState} folder={folderName} />}
            </section>

            {sidebarPosition === 'right' && sidebar}

            <PreviewDrawer item={previewItem} onClose={() => setPreviewItem(null)} />
        </div>
    )
})

export default FilePanel

/**
 * The line under the list: how many items the folder holds, or how many are selected and their
 * size, the listing's progress while rows arrive, and the space left on the remote.
 */
function PanelStatusBar({
    items,
    selectedPaths,
    status,
    isFavorites,
    isSearch,
    remote,
}: {
    items: readonly Entry[]
    selectedPaths: ReadonlySet<string>
    status: PanelStatus | null
    isFavorites: boolean
    isSearch: boolean
    /** The remote's config name, for its quota. Null on this computer and in the favorites. */
    remote: string | null
}) {
    let folders = 0
    let selectedBytes = 0
    for (const item of items) {
        if (item.isDir) folders++
        if (selectedPaths.has(item.key) && typeof item.size === 'number' && item.size > 0) {
            selectedBytes += item.size
        }
    }
    const files = items.length - folders
    const summary = isFavorites
        ? plural(items.length, { one: '# favorite', other: '# favorites' })
        : isSearch
          ? plural(items.length, { one: '# match', other: '# matches' })
          : contentsWords(folders, files)

    const selected = selectedPaths.size
    const selectedWords = plural(selected, { one: '# selected', other: '# selected' })
    const selectedSize = selectedBytes > 0 ? formatBytes(selectedBytes) : null
    const quota = useRemoteHealth().data?.[remote ?? '']?.about
    const free = remote ? quota?.free : undefined
    const used = quota?.used
    const total = quota?.total

    return (
        <footer className="flex items-center h-8 gap-3 px-3 text-xs border-t shrink-0 border-divider text-default-500 tabular-nums">
            {selected > 0 ? (
                // One sentence in parts: "3 selected · 1.5 MB of 2 folders, 10 files". The size is
                // left out when nothing selected has one.
                <span className="flex items-center min-w-0 gap-1.5 truncate">
                    {selectedSize ? (
                        <Trans comment='What is selected in a file list: "3 selected · 1.5 MB of 2 folders, 10 files".'>
                            <span className="font-medium text-primary">{selectedWords}</span>
                            <span>· {selectedSize}</span>
                            <span className="hidden @md:inline text-default-400">of {summary}</span>
                        </Trans>
                    ) : (
                        <Trans comment='What is selected in a file list: "3 selected of 2 folders, 10 files".'>
                            <span className="font-medium text-primary">{selectedWords}</span>
                            <span className="hidden @md:inline text-default-400">of {summary}</span>
                        </Trans>
                    )}
                </span>
            ) : (
                <span className="truncate">{summary}</span>
            )}
            {status && (
                <output className="flex items-center gap-1.5 truncate">
                    <StatusDot kind={status.kind} />
                    {status.text}
                </output>
            )}
            {typeof free === 'number' && (
                <span className="flex items-center gap-2 ml-auto shrink-0">
                    {typeof used === 'number' && typeof total === 'number' && total > 0 && (
                        <ToneProgress
                            tone={used / total > 0.9 ? 'red' : 'blue'}
                            value={used / total}
                            label={t`Space used on the remote`}
                            className="hidden w-12 h-1 @sm:block"
                        />
                    )}
                    {freeWords(free)}
                </span>
            )}
        </footer>
    )
}

/** What a folder holds: "3 folders, 12 files", one of the two, or "No items". */
function contentsWords(folders: number, files: number): string {
    const folderWords = plural(folders, { one: '# folder', other: '# folders' })
    const fileWords = plural(files, { one: '# file', other: '# files' })
    if (folders > 0 && files > 0) {
        return t({
            message: `${folderWords}, ${fileWords}`,
            comment: 'The folders and the files that a folder holds: "3 folders, 12 files".',
        })
    }
    if (folders > 0) return folderWords
    if (files > 0) return fileWords
    return t`No items`
}

function freeWords(bytes: number): string {
    const size = formatBytes(bytes)
    return t({ message: `${size} free`, comment: 'The space left on a remote: "12.5 GB free".' })
}

/**
 * Shown over the panel while rows are dragged on it. It says what a drop would do: land in the
 * folder shown, or nothing, because the rows would land on themselves.
 */
function DropHint({ state, folder }: { state: 'accept' | 'refuse'; folder: string }) {
    const accept = state === 'accept'
    return (
        <div
            aria-hidden={true}
            className={cn(
                'absolute inset-0 z-30 flex items-end justify-center pb-14 pointer-events-none ring-2 ring-inset rounded-2xl',
                accept ? 'ring-primary bg-primary/5' : 'ring-danger/60 bg-danger/5'
            )}
        >
            <div className="flex items-center gap-2.5 py-2 pl-2 pr-4 rounded-full shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.35)] bg-content1 dark:bg-zinc-800 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_12px_32px_-8px_rgb(0_0_0/0.7)]">
                <IconTile
                    icon={accept ? FolderArrowDownIcon : XmarkCircleIcon}
                    tone={accept ? 'blue' : 'red'}
                    size="md"
                />
                <span className="text-sm leading-tight">
                    {accept ? (
                        <Trans>
                            Drop into <span className="font-semibold">{folder}</span>
                        </Trans>
                    ) : (
                        <Trans>Items can’t be dropped onto themselves</Trans>
                    )}
                </span>
            </div>
        </div>
    )
}
