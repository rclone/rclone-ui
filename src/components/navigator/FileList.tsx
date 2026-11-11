import { Button, Checkbox, cn, Listbox, ListboxItem, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    DownloadBracket as DownloadBracketIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Pen as PenIcon,
    Share as ShareIcon,
    Star as StarIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import {
    type ComponentType,
    cloneElement,
    createContext,
    type HTMLAttributes,
    type Key,
    type DragEvent as ReactDragEvent,
    type ReactElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { formatBytes, formatNumber } from '../../../lib/format'
import { IconTile } from '../look/IconTile'
import type { Tone } from '../look/tones'
import FileIcon from './FileIcon'
import type { Entry, PaddingItem, VirtualizedEntry } from './types'
import { dragStateRef, formatModTime } from './utils'

/**
 * A row and the actions it offers. The list caches each row's element by its item (React
 * Stately's collection) and renders it again only for a new item. So everything a row shows must
 * be stored on the item, and never read from a prop at render time.
 */
type ListRow = VirtualizedEntry & {
    isDisabled: boolean
    /** A file in a folder picker. It is shown greyed out and can't be picked or opened. */
    folderOnly: boolean
    draggable: boolean
    showFullPath: boolean
    canFavorite: boolean
    canDownload: boolean
    canShare: boolean
    canRename: boolean
    canDelete: boolean
}

// By default, react-aria's list handles Tab itself and skips past all the rows at once. With this
// option, Tab reaches the checkbox and the buttons in each row. HeroUI passes the option through
// even though its types don't declare it.
const TAB_INTO_ROWS = { allowsTabNavigation: true }

/** The height of a row, in px. The list is virtualized, so every row has this height. */
export const ROW_HEIGHT = 36

/**
 * A row's columns, which FilePanel sets on the panel (`--file-columns`), so they line up with the
 * header and follow Name's width. A narrow panel uses the compact ones, without Modified.
 */
export const ROW_GRID = 'grid-cols-(--file-columns) @max-lg:grid-cols-(--file-columns-compact)'

/** How wide the rows are at least: Name's width and the other columns. */
export const ROWS_MIN_WIDTH = 'min-w-(--rows-min) @max-lg:min-w-(--rows-min-compact)'

const ROW_ACTION = 'min-w-7 w-7 h-7 rounded-md text-default-600'

// The size and date, which give their place to the row's actions while those show.
const UNDER_ACTIONS =
    'transition-opacity duration-100 group-hover:opacity-0 group-has-focus-visible:opacity-0'

const FOLDERS_ONLY = t`Only folders can be picked here.`

/** How long a row is hovered before its hint opens, in ms. */
const HINT_DELAY = 500

// A favorite row is labeled "(remote) name" in a list with no path bar above it, so hovering it
// shows the path it points to. Every other listing already shows its path. A file in a folder
// picker explains why it can't be picked (`FolderOnlyHint`).
function RowTooltip({
    path,
    folderOnly,
    children,
}: {
    path?: string
    folderOnly: boolean
    children: ReactElement<HTMLAttributes<HTMLElement>>
}) {
    if (folderOnly) return <FolderOnlyHint>{children}</FolderOnlyHint>
    if (!path) return children
    return (
        <Tooltip content={path} size="sm" placement="bottom" delay={300} closeDelay={0}>
            {children}
        </Tooltip>
    )
}

// Whether the hint of the row it is in is open. The row holds the state, and the hint is drawn
// under its name (`HintAnchor`). It is null outside a row that can't be picked.
const HintOpen = createContext<boolean | null>(null)

/**
 * The hint of a file that a folder picker can't pick. A tooltip opens on hover only when the
 * mouse was the last thing pressed, and a press closes it. But a file is often hovered right
 * after typing a search, and clicked to see why it doesn't open. So this hint opens after any
 * 500 ms hover of the row, stays open through a click, and closes on Esc or when the pointer
 * leaves.
 */
function FolderOnlyHint({ children }: { children: ReactElement<HTMLAttributes<HTMLElement>> }) {
    const [isOpen, setOpen] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    useEffect(() => {
        if (!isOpen) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [isOpen])
    return (
        <HintOpen.Provider value={isOpen}>
            {cloneElement(children, {
                onPointerEnter: () => {
                    clearTimeout(timer.current)
                    timer.current = setTimeout(() => setOpen(true), HINT_DELAY)
                },
                onPointerLeave: () => {
                    clearTimeout(timer.current)
                    setOpen(false)
                },
            })}
        </HintOpen.Provider>
    )
}

// The hint, under the name of the row that holds it open.
function HintAnchor({ children }: { children: ReactElement }) {
    const isOpen = useContext(HintOpen)
    if (isOpen === null) return children
    return (
        <Tooltip
            content={FOLDERS_ONLY}
            size="lg"
            placement="bottom-start"
            classNames={{ content: 'bg-white text-black' }}
            closeDelay={0}
            isOpen={isOpen}
        >
            {children}
        </Tooltip>
    )
}

/**
 * The virtualized list's own scroller, a div inside HeroUI's Listbox. This is the one place that
 * relies on the Listbox's markup.
 */
function scrollerIn(root: HTMLElement | null): HTMLElement | null {
    for (const element of root?.querySelectorAll<HTMLElement>('div') ?? []) {
        if (element.style.overflow === 'auto') return element
    }
    return null
}

export default function FileList({
    items,
    isLoading,
    error,
    onRetry,
    empty,
    selectedKeys,
    onToggleSelect,
    onNavigate,
    allowMultiple,
    foldersOnly = false,
    onPreviewClick,
    draggable = false,
    showFullPath = false,
    onToggleFavorite,
    onDownload,
    onShare,
    onRename,
    onDelete,
    listHeight,
    folder,
    restoreScrollTop,
    onScrollTopChange,
}: {
    items: (VirtualizedEntry | PaddingItem)[]
    isLoading: boolean
    error: string | null
    /** Lists the folder again, from the error's "Try again". */
    onRetry?: () => void
    /** What an empty list says, and the action that fills it. */
    empty?: EmptyListing
    selectedKeys: Set<string>
    onToggleSelect: (entry: Entry) => void
    onNavigate: (entry: Entry) => void
    allowMultiple: boolean
    /** For a folder picker. Files are greyed out and can't be picked or opened. */
    foldersOnly?: boolean
    onPreviewClick?: (entry: Entry) => void
    /** Rows can be dragged onto a Commander panel. The items travel in the drag's data. */
    draggable?: boolean
    /** Shows the row's full path in a tooltip, for the favorites list whose labels aren't paths. */
    showFullPath?: boolean
    onToggleFavorite?: (entry: Entry, isFavorited: boolean) => void
    onDownload?: (entry: Entry) => void
    onShare?: (entry: Entry) => void
    onRename?: (entry: Entry) => void
    onDelete?: (entry: Entry) => void
    listHeight: number
    /** The folder shown. Another folder starts at the top. */
    folder?: string | null
    /** Where the list was scrolled when the panel was left, applied once the rows show. */
    restoreScrollTop?: number
    onScrollTopChange?: (scrollTop: number) => void
}) {
    const handleDragStart = useCallback(
        (entry: VirtualizedEntry, event: ReactDragEvent) => {
            if (!draggable) return

            const selectedEntries: Entry[] = []
            if (selectedKeys.has(entry.key)) {
                for (const item of items) {
                    if ('padding' in item) continue
                    if (selectedKeys.has(item.key)) {
                        selectedEntries.push(item)
                    }
                }
            } else {
                selectedEntries.push(entry)
            }

            dragStateRef.current = selectedEntries.map((e) => ({
                path: e.fullPath,
                type: e.isDir ? 'folder' : 'file',
            }))
            // The items are included in the drag data, with their types, for drops into another
            // window. A folder's path has no trailing slash, so the path alone can't show the type.
            event.dataTransfer.setData('application/json', JSON.stringify(dragStateRef.current))
            event.dataTransfer.effectAllowed = 'copyMove'

            const count = selectedEntries.length
            // A pill in the window's blue that names what is dragged, and counts it.
            const dragPreview = document.createElement('div')
            dragPreview.style.cssText = `
                position: fixed;
                top: -1000px;
                left: -1000px;
                display: flex;
                align-items: center;
                gap: 8px;
                max-width: 280px;
                padding: 6px 14px 6px 8px;
                background: linear-gradient(#38bdf8, #2563eb);
                color: white;
                border-radius: 999px;
                font: 600 13px/18px system-ui, sans-serif;
                box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3), 0 8px 20px -6px rgb(37 99 235 / 0.6);
                white-space: nowrap;
                pointer-events: none;
            `
            const badge = document.createElement('span')
            badge.style.cssText = `
                min-width: 20px;
                padding: 0 6px;
                border-radius: 999px;
                background: rgb(255 255 255 / 0.25);
                text-align: center;
                font-variant-numeric: tabular-nums;
            `
            badge.textContent = formatNumber(count)
            const name = document.createElement('span')
            name.style.cssText = 'overflow: hidden; text-overflow: ellipsis;'
            name.textContent =
                count === 1
                    ? selectedEntries[0].name
                    : plural(count, { one: '# item', other: '# items' })
            dragPreview.append(badge, name)
            document.body.appendChild(dragPreview)
            event.dataTransfer.setDragImage(dragPreview, 16, dragPreview.offsetHeight / 2)
            requestAnimationFrame(() => document.body.removeChild(dragPreview))
        },
        [draggable, selectedKeys, items]
    )

    // The panel's `drop` handler, in this window or another, handles the drop. The end of a drag
    // only forgets the items. So a drag cancelled with Esc, or dropped where nothing accepts it,
    // starts nothing, and a later drop from outside the app (which has no items) isn't mistaken
    // for this one.
    const handleDragEnd = useCallback(() => {
        dragStateRef.current = null
    }, [])

    const anySelected = selectedKeys.size > 0
    const rows = useMemo(
        () =>
            items.map((item): ListRow | PaddingItem =>
                'padding' in item
                    ? item
                    : {
                          ...item,
                          isDisabled: !allowMultiple && anySelected && !item.isSelected,
                          folderOnly: foldersOnly && !item.isDir,
                          // A row that can't be picked offers nothing but its hint.
                          draggable: draggable && !(foldersOnly && !item.isDir),
                          showFullPath,
                          canFavorite: item.isDir && !!onToggleFavorite,
                          canDownload: !!onDownload && !(foldersOnly && !item.isDir),
                          canShare: !!onShare && !(foldersOnly && !item.isDir),
                          canRename: !!onRename && !(foldersOnly && !item.isDir),
                          canDelete: !!onDelete && !(foldersOnly && !item.isDir),
                      }
            ),
        [
            items,
            allowMultiple,
            anySelected,
            foldersOnly,
            draggable,
            showFullPath,
            onToggleFavorite,
            onDownload,
            onShare,
            onRename,
            onDelete,
        ]
    )

    // The handlers that a row calls, read at the time of the call. Row elements are cached by
    // item (`ListRow`), so the handlers a row was rendered with may be several renders old.
    const latest = useRef({
        onToggleSelect,
        onNavigate,
        onPreviewClick,
        onToggleFavorite,
        onDownload,
        onShare,
        onRename,
        onDelete,
        handleDragStart,
    })
    useLayoutEffect(() => {
        latest.current = {
            onToggleSelect,
            onNavigate,
            onPreviewClick,
            onToggleFavorite,
            onDownload,
            onShare,
            onRename,
            onDelete,
            handleDragStart,
        }
    })

    // A row's action, from a click or Enter. Folders open in the panel, and files open the
    // preview. Without a preview it falls back to onNavigate, which does nothing for files.
    const handleAction = useCallback(
        (key: Key) => {
            const entry = items.find((item) => !('padding' in item) && item.key === key)
            if (!entry || 'padding' in entry) return
            if (foldersOnly && !entry.isDir) return
            const { onNavigate: navigate, onPreviewClick: preview } = latest.current
            if (entry.isDir || !preview) navigate(entry)
            else preview(entry)
        },
        [items, foldersOnly]
    )

    // The scroll position is reported as it changes. The one kept from before is applied when
    // the rows show. The list measures itself and may scroll back to the top over its first
    // frames, so the restore holds the position for a second (and again as more rows arrive),
    // until the user scrolls. Another folder starts at the top.
    const rootRef = useRef<HTMLDivElement>(null)
    const listShown = !isLoading && !error && items.some((item) => !('padding' in item))
    const pendingScroll = useRef(restoreScrollTop || undefined)
    const onScrollTop = useRef(onScrollTopChange)
    useLayoutEffect(() => {
        onScrollTop.current = onScrollTopChange
    })
    useEffect(() => {
        if (!listShown) return
        const scroller = scrollerIn(rootRef.current)
        if (!scroller) return
        // While the restore holds the position, only the user's scrolls are reported, and they
        // end it.
        const report = () => {
            if (pendingScroll.current === undefined) onScrollTop.current?.(scroller.scrollTop)
        }
        const userScrolls = () => {
            pendingScroll.current = undefined
        }
        const intents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
        scroller.addEventListener('scroll', report, { passive: true })
        for (const name of intents) {
            scroller.addEventListener(name, userScrolls, { passive: true })
        }
        return () => {
            scroller.removeEventListener('scroll', report)
            for (const name of intents) scroller.removeEventListener(name, userScrolls)
        }
    }, [listShown])
    const rowCount = items.length
    // biome-ignore lint/correctness/useExhaustiveDependencies: more rows may make the list tall enough
    useEffect(() => {
        if (!listShown || pendingScroll.current === undefined) return
        let frame = 0
        let frames = 60
        const hold = () => {
            const wanted = pendingScroll.current
            if (wanted === undefined) return
            const scroller = scrollerIn(rootRef.current)
            if (scroller && Math.abs(scroller.scrollTop - wanted) > 1) scroller.scrollTop = wanted
            frames -= 1
            if (frames > 0) {
                frame = requestAnimationFrame(hold)
                return
            }
            // The list is as tall as it gets for now. Unless it is still too short, the restore
            // is done.
            if (scroller && scroller.scrollHeight - scroller.clientHeight >= wanted) {
                pendingScroll.current = undefined
                onScrollTop.current?.(scroller.scrollTop)
            }
        }
        hold()
        return () => cancelAnimationFrame(frame)
    }, [listShown, rowCount])
    const shownFolder = useRef(folder)
    useEffect(() => {
        if (shownFolder.current === folder) return
        shownFolder.current = folder
        // The pending scroll was for the first folder.
        pendingScroll.current = undefined
        const scroller = scrollerIn(rootRef.current)
        if (scroller) scroller.scrollTop = 0
    }, [folder])

    if (isLoading) return <SkeletonRows />

    if (error) {
        // Show the full sentence, because a refused path explains what a name may contain.
        return (
            <ListState
                icon={ExclamationTriangleIcon}
                tone="red"
                title={t`This folder can't be shown`}
                description={error}
                action={
                    onRetry && (
                        <Button size="sm" variant="flat" onPress={onRetry}>
                            <Trans>Try again</Trans>
                        </Button>
                    )
                }
            />
        )
    }

    const visibleItems = items.filter((item) => !('padding' in item)) as VirtualizedEntry[]

    if (visibleItems.length === 0) {
        return (
            <ListState
                icon={empty?.icon}
                tone={empty?.tone ?? 'graphite'}
                title={empty?.title ?? t`No items`}
                description={empty?.description}
                action={empty?.action}
            />
        )
    }

    const list = (
        <Listbox
            aria-label={t`Files`}
            items={rows}
            isVirtualized={true}
            virtualization={{
                // The list sits 4 px under the column header (its container's padding).
                maxListboxHeight: listHeight - 4,
                itemHeight: ROW_HEIGHT,
            }}
            classNames={{
                base: 'w-full p-0 m-0',
                list: 'w-full p-0 m-0 gap-0',
            }}
            selectionMode="none"
            hideSelectedIcon={true}
            selectedKeys={[]}
            shouldHighlightOnFocus={false}
            autoFocus={false}
            disallowEmptySelection={false}
            onAction={handleAction}
            {...TAB_INTO_ROWS}
        >
            {(item) => {
                if ('padding' in item && item.padding) {
                    return (
                        <ListboxItem
                            key={item.key}
                            // A zero-width space: the spacer needs a text for react-aria, and no one
                            // types it to jump to the spacer.
                            textValue={'\u200b'}
                            isDisabled={true}
                            className="p-0 m-0 pointer-events-none"
                        >
                            <div style={{ height: ROW_HEIGHT }} aria-hidden="true" />
                        </ListboxItem>
                    )
                }
                const entry = item as ListRow
                const label = entry.displayName ?? entry.name

                const hasActions =
                    entry.canFavorite ||
                    entry.canDownload ||
                    entry.canShare ||
                    entry.canRename ||
                    entry.canDelete

                return (
                    <ListboxItem
                        key={entry.key}
                        textValue={label}
                        classNames={{
                            base: 'group/row px-1.5 py-px m-0 h-full rounded-none bg-transparent! outline-hidden! data-[focus-visible=true]:outline-hidden! focus:outline-hidden!',
                            title: 'h-full flex',
                        }}
                    >
                        <RowTooltip
                            path={entry.showFullPath ? entry.fullPath : undefined}
                            folderOnly={entry.folderOnly}
                        >
                            <div
                                className={cn(
                                    'relative grid items-center w-full h-full rounded-lg group cursor-pointer',
                                    ROW_GRID,
                                    entry.isSelected
                                        ? // In the accent while the panel is the active one, grey otherwise.
                                          'bg-default-200/70 dark:bg-white/10 group-data-[focused=true]/panel:bg-primary/12 dark:group-data-[focused=true]/panel:bg-primary/25'
                                        : 'hover:bg-default-100 dark:hover:bg-white/6',
                                    entry.folderOnly && 'opacity-disabled cursor-not-allowed',
                                    // The row that has keyboard focus.
                                    'group-data-[focus-visible=true]/row:ring-2 group-data-[focus-visible=true]/row:ring-inset group-data-[focus-visible=true]/row:ring-primary'
                                )}
                                aria-disabled={entry.folderOnly || undefined}
                                draggable={entry.draggable}
                                onDragStart={(e) => latest.current.handleDragStart(entry, e)}
                                onDragEnd={handleDragEnd}
                            >
                                <div
                                    className="flex items-center justify-end cursor-default"
                                    // Clicking the checkbox shouldn't open the row.
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Checkbox
                                        size="sm"
                                        isSelected={entry.isSelected}
                                        isDisabled={entry.isDisabled || entry.folderOnly}
                                        onValueChange={() => latest.current.onToggleSelect(entry)}
                                        aria-label={t`Select ${label}`}
                                        classNames={{ wrapper: 'me-0' }}
                                    />
                                </div>

                                <div className="flex items-center h-full min-w-0 gap-2.5 pl-2.5 pr-2">
                                    <FileIcon entry={entry} size="md" />
                                    <HintAnchor>
                                        <span
                                            className="truncate text-[13px] leading-5"
                                            title={
                                                entry.showFullPath || entry.folderOnly
                                                    ? undefined
                                                    : entry.fullPath
                                            }
                                        >
                                            {label}
                                        </span>
                                    </HintAnchor>
                                    {entry.isFavorited && entry.canFavorite && (
                                        <StarIcon
                                            variant="filled"
                                            aria-hidden={true}
                                            className="size-3 shrink-0 text-warning"
                                        />
                                    )}
                                </div>

                                <div
                                    className={cn(
                                        'pr-3 text-xs text-right truncate tabular-nums text-default-500',
                                        hasActions && UNDER_ACTIONS
                                    )}
                                >
                                    {typeof entry.size === 'number' && entry.size >= 0
                                        ? formatBytes(entry.size)
                                        : '—'}
                                </div>

                                <div
                                    className={cn(
                                        'text-xs truncate tabular-nums text-default-500 @max-lg:hidden',
                                        hasActions && UNDER_ACTIONS
                                    )}
                                >
                                    {formatModTime(entry.modTime)}
                                </div>

                                <div />

                                {hasActions && (
                                    // The row's actions, in place of its size and date while the row
                                    // is hovered or has keyboard focus. They can be tabbed to while
                                    // hidden, and show once one of them has focus.
                                    <div
                                        className={cn(
                                            'absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-px p-0.5 rounded-[10px]',
                                            'bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_2px_8px_-2px_rgb(0_0_0/0.16)] dark:bg-zinc-800 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_2px_8px_-2px_rgb(0_0_0/0.6)]',
                                            'opacity-0 pointer-events-none transition-opacity duration-100',
                                            'group-hover:opacity-100 group-hover:pointer-events-auto group-has-focus-visible:opacity-100 group-has-focus-visible:pointer-events-auto'
                                        )}
                                    >
                                        {entry.canFavorite && (
                                            <Button
                                                isIconOnly={true}
                                                size="sm"
                                                variant="light"
                                                className={cn(
                                                    ROW_ACTION,
                                                    entry.isFavorited && 'text-warning'
                                                )}
                                                aria-label={
                                                    entry.isFavorited
                                                        ? t`Remove ${label} from favorites`
                                                        : t`Add ${label} to favorites`
                                                }
                                                onPress={() =>
                                                    latest.current.onToggleFavorite?.(
                                                        entry,
                                                        entry.isFavorited
                                                    )
                                                }
                                            >
                                                <StarIcon
                                                    variant={
                                                        entry.isFavorited ? 'filled' : 'regular'
                                                    }
                                                    className="size-4"
                                                />
                                            </Button>
                                        )}
                                        {entry.canDownload && (
                                            <Button
                                                isIconOnly={true}
                                                size="sm"
                                                variant="light"
                                                className={ROW_ACTION}
                                                aria-label={t`Download ${label}`}
                                                onPress={() => latest.current.onDownload?.(entry)}
                                            >
                                                <DownloadBracketIcon className="size-4" />
                                            </Button>
                                        )}
                                        {entry.canShare && (
                                            <Button
                                                isIconOnly={true}
                                                size="sm"
                                                variant="light"
                                                className={ROW_ACTION}
                                                aria-label={t`Share ${label}`}
                                                onPress={() => latest.current.onShare?.(entry)}
                                            >
                                                <ShareIcon className="size-4" />
                                            </Button>
                                        )}
                                        {entry.canRename && (
                                            <Button
                                                isIconOnly={true}
                                                size="sm"
                                                variant="light"
                                                className={ROW_ACTION}
                                                aria-label={t`Rename ${label}`}
                                                onPress={() => latest.current.onRename?.(entry)}
                                            >
                                                <PenIcon className="size-4" />
                                            </Button>
                                        )}
                                        {entry.canDelete && (
                                            <Button
                                                isIconOnly={true}
                                                size="sm"
                                                variant="light"
                                                color="danger"
                                                className={cn(ROW_ACTION, 'text-danger')}
                                                aria-label={t`Delete ${label}`}
                                                onPress={() => latest.current.onDelete?.(entry)}
                                            >
                                                <TrashIcon className="size-4" />
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </RowTooltip>
                    </ListboxItem>
                )
            }}
        </Listbox>
    )

    // The panel sets the column template, so resizing Name also updates rows that are already
    // rendered.
    return (
        <div ref={rootRef} className="relative w-full h-full pt-1">
            {list}
        </div>
    )
}

export type EmptyListing = {
    icon?: ComponentType<{ className?: string }>
    tone?: Tone
    title: string
    description?: ReactNode
    action?: ReactNode
}

/** A list with nothing to show: empty, or failed. It sits in the middle of the panel. */
function ListState({
    icon,
    tone,
    title,
    description,
    action,
}: {
    icon?: ComponentType<{ className?: string }>
    tone: Tone
    title: string
    description?: ReactNode
    action?: ReactNode
}) {
    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-3 px-8 pb-10 text-center">
            {icon && <IconTile icon={icon} tone={tone} size="lg" />}
            <div className="flex flex-col items-center gap-1 max-w-80">
                <p className="text-sm font-semibold">{title}</p>
                {description && (
                    <p className="text-xs leading-relaxed text-default-500 text-pretty [overflow-wrap:anywhere]">
                        {description}
                    </p>
                )}
            </div>
            {action}
        </div>
    )
}

// Name widths for the placeholder rows, so they read as names rather than a pattern.
const SKELETON_WIDTHS = [62, 44, 71, 38, 55, 66, 47, 59, 35, 52, 68, 41]

/** Rows shaped like the folder's, shown while it is listed. */
function SkeletonRows() {
    return (
        <div
            role="status"
            aria-label={t`Loading`}
            className="flex flex-col w-full h-full gap-0.5 px-1.5 pt-1 overflow-hidden"
        >
            {SKELETON_WIDTHS.map((width, index) => (
                <div
                    key={width}
                    className={cn('grid items-center shrink-0 motion-safe:animate-pulse', ROW_GRID)}
                    style={{ height: ROW_HEIGHT - 2, animationDelay: `${index * 60}ms` }}
                >
                    <span className="justify-self-end rounded-[4px] size-4 bg-default-200/80 dark:bg-default-100" />
                    <span className="flex items-center gap-2.5 pl-2.5">
                        <span className="rounded-md size-5 shrink-0 bg-default-200/80 dark:bg-default-100" />
                        <span
                            className="h-2.5 rounded-full bg-default-200/80 dark:bg-default-100"
                            style={{ width: `${width}%` }}
                        />
                    </span>
                    <span className="justify-self-end w-10 h-2 mr-3 rounded-full bg-default-200/60 dark:bg-default-100/70" />
                    <span className="w-16 h-2 rounded-full bg-default-200/60 dark:bg-default-100/70 @max-lg:hidden" />
                    <span />
                </div>
            ))}
        </div>
    )
}
