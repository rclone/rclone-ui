import { Button, Checkbox, Listbox, ListboxItem, cn } from '@heroui/react'
import { platform } from '@tauri-apps/plugin-os'
import { DownloadIcon, PencilIcon, Share2Icon, StarIcon, Trash2Icon } from 'lucide-react'
import { useCallback } from 'react'
import { formatBytes } from '../../../lib/format.ts'
import FileIcon from './FileIcon'
import type { Entry, PaddingItem, VirtualizedEntry } from './types'
import { dragStateRef, dropTargetsRef, formatModTime } from './utils'

export default function FileList({
    items,
    isLoading,
    error,
    selectedKeys,
    onToggleSelect,
    onNavigate,
    selectionMode,
    allowMultiple,
    showPreviewColumn = false,
    onPreviewClick,
    draggable = false,
    onDragStart,
    onContextMenu,
    favoritedKeys,
    onToggleFavorite,
    onDownload,
    onShare,
    onRename,
    onDelete,
    listHeight,
    columnTemplate,
}: {
    items: (VirtualizedEntry | PaddingItem)[]
    isLoading: boolean
    error: string | null
    selectedKeys: Set<string>
    onToggleSelect: (entry: Entry) => void
    onNavigate: (entry: Entry) => void
    selectionMode: 'checkbox' | 'drag' | 'both'
    allowMultiple: boolean
    showPreviewColumn?: boolean
    onPreviewClick?: (entry: Entry) => void
    draggable?: boolean
    onDragStart?: (items: Entry[]) => void
    onContextMenu?: (entry: Entry, event: React.MouseEvent) => void
    favoritedKeys?: Record<string, boolean>
    onToggleFavorite?: (entry: Entry, isFavorited: boolean) => void
    onDownload?: (entry: Entry) => void
    onShare?: (entry: Entry) => void
    onRename?: (entry: Entry) => void
    onDelete?: (entry: Entry) => void
    listHeight: number
    /** The panel header's grid template — rows must line up with it (see useNameColumnResize). */
    columnTemplate: string
}) {
    const showCheckbox = selectionMode === 'checkbox' || selectionMode === 'both'

    const handleDragStart = useCallback(
        (entry: VirtualizedEntry, event: React.DragEvent) => {
            if (!draggable || !onDragStart) return

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

            const paths = selectedEntries.map((e) => e.fullPath)
            dragStateRef.current = selectedEntries.map((e) => ({
                path: e.fullPath,
                type: e.isDir ? 'folder' : 'file',
            }))
            event.dataTransfer.setData('application/json', JSON.stringify(paths))
            event.dataTransfer.effectAllowed = 'copyMove'

            const count = selectedEntries.length
            const dragPreview = document.createElement('div')
            dragPreview.style.cssText = `
                position: fixed;
                top: -1000px;
                left: -1000px;
                padding: 8px 16px;
                background: hsl(var(--heroui-primary-500));
                color: white;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                white-space: nowrap;
                pointer-events: none;
            `
            dragPreview.textContent = count === 1 ? selectedEntries[0].name : `${count} items`
            document.body.appendChild(dragPreview)
            event.dataTransfer.setDragImage(
                dragPreview,
                dragPreview.offsetWidth / 2,
                dragPreview.offsetHeight / 2
            )
            requestAnimationFrame(() => document.body.removeChild(dragPreview))

            onDragStart(selectedEntries)
        },
        [draggable, onDragStart, selectedKeys, items]
    )

    const handleDragEnd = useCallback((event: React.DragEvent) => {
        if (!dragStateRef.current || dragStateRef.current.length === 0) return

        const mouseX = event.clientX
        const mouseY = event.clientY

        for (const [_id, target] of dropTargetsRef.current) {
            const rect = target.element.getBoundingClientRect()
            if (
                mouseX >= rect.left &&
                mouseX <= rect.right &&
                mouseY >= rect.top &&
                mouseY <= rect.bottom
            ) {
                const destination = target.getDestination()
                target.onDrop(dragStateRef.current, destination)
                break
            }
        }
        dragStateRef.current = null
    }, [])

    const handleContextMenu = useCallback(
        (entry: VirtualizedEntry, event: React.MouseEvent) => {
            if (!onContextMenu) return
            event.preventDefault()
            onContextMenu(entry, event)
        },
        [onContextMenu]
    )

    if (isLoading) {
        return (
            <div className="flex items-center justify-center flex-1 w-full h-full">
                <div className="animate-blink">Loading...</div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex items-center justify-center w-full h-full text-danger">
                {error}
            </div>
        )
    }

    const visibleItems = items.filter((item) => !('padding' in item)) as VirtualizedEntry[]

    if (visibleItems.length === 0) {
        return (
            <div className="flex items-center justify-center w-full h-full text-default-500">
                No items
            </div>
        )
    }

    return (
        <Listbox
            items={items}
            isVirtualized={true}
            virtualization={{
                maxListboxHeight: listHeight,
                itemHeight: 50,
            }}
            classNames={{
                base: 'w-full p-0 m-0',
                list: 'w-full p-0 m-0 gap-0',
            }}
            // @ts-ignore — scrollShadowProps exists on VirtualizedListbox but not on ListboxProps (HeroUI typing gap)
            scrollShadowProps={{
                className: platform() !== 'macos' ? 'show-scrollbar' : undefined,
            }}
            selectionMode="none"
            hideSelectedIcon={true}
            selectedKeys={[]}
            shouldHighlightOnFocus={false}
            autoFocus={false}
            disallowEmptySelection={false}
        >
            {(item) => {
                if ('padding' in item && item.padding) {
                    return (
                        <ListboxItem
                            key={item.key}
                            isDisabled={true}
                            className="p-0 m-0 pointer-events-none"
                        >
                            <div className="h-[50px]" aria-hidden="true" />
                        </ListboxItem>
                    )
                }
                const entry = item as VirtualizedEntry
                const isSelected = entry.isSelected
                const isDisabled = !allowMultiple && selectedKeys.size > 0 && !isSelected
                const isFavorited = favoritedKeys?.[entry.key] ?? false

                return (
                    <ListboxItem
                        key={entry.key}
                        textValue={entry.displayName ?? entry.name}
                        classNames={{
                            base: 'p-0 m-0 rounded-none !outline-none data-[focus-visible=true]:!outline-none focus:!outline-none',
                            title: 'h-full justify-center flex',
                        }}
                    >
                        <div
                            className={cn(
                                'grid items-center hover:bg-content2 py-2 border-b border-divider group transition-colors w-full h-full',
                                isSelected ? 'bg-primary-50 hover:bg-primary-100' : ''
                            )}
                            style={{ gridTemplateColumns: columnTemplate }}
                            draggable={draggable}
                            onDragStart={(e) => handleDragStart(entry, e)}
                            onDragEnd={handleDragEnd}
                            onContextMenu={(e) => handleContextMenu(entry, e)}
                        >
                            {showCheckbox && (
                                <div
                                    className="flex items-center justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Checkbox
                                        isSelected={isSelected}
                                        isDisabled={isDisabled}
                                        onValueChange={() => onToggleSelect(entry)}
                                        aria-label="Select item"
                                    />
                                </div>
                            )}
                            {!showCheckbox && <div />}

                            <div
                                className="flex items-center h-full gap-2 pl-2 overflow-hidden cursor-pointer"
                                // Folders navigate in; files open the preview (falls back
                                // to onNavigate — a no-op for files — where preview is off).
                                onClick={() =>
                                    entry.isDir || !onPreviewClick
                                        ? onNavigate(entry)
                                        : onPreviewClick(entry)
                                }
                            >
                                <FileIcon entry={entry} size="md" />
                                <span className="truncate !cursor-pointer" title={entry.fullPath}>
                                    {entry.displayName ?? entry.name}
                                </span>
                            </div>

                            <div className="truncate text-small text-default-500">
                                {typeof entry.size === 'number' && entry.size >= 0
                                    ? formatBytes(entry.size)
                                    : '—'}
                            </div>

                            <div className="truncate text-small text-default-500">
                                {formatModTime(entry.modTime)}
                            </div>

                            {showPreviewColumn ? (
                                <div className="flex items-center justify-end gap-1 pr-2">
                                    {entry.isDir && onToggleFavorite && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            color="warning"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onToggleFavorite(entry, isFavorited)}
                                        >
                                            <StarIcon
                                                className={cn(
                                                    'size-5',
                                                    isFavorited && 'fill-warning'
                                                )}
                                            />
                                        </Button>
                                    )}
                                    {onDownload && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onDownload(entry)}
                                        >
                                            <DownloadIcon className="size-5" />
                                        </Button>
                                    )}
                                    {onShare && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onShare(entry)}
                                        >
                                            <Share2Icon className="size-4" />
                                        </Button>
                                    )}
                                    {onRename && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onRename(entry)}
                                        >
                                            <PencilIcon className="size-4" />
                                        </Button>
                                    )}
                                    {onDelete && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            color="danger"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onDelete(entry)}
                                        >
                                            <Trash2Icon className="size-4" />
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <div className="flex items-center justify-center w-10 shrink-0">
                                    {entry.isDir && onToggleFavorite && (
                                        <Button
                                            isIconOnly={true}
                                            size="sm"
                                            variant="light"
                                            color="warning"
                                            className="transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                                            onPress={() => onToggleFavorite(entry, isFavorited)}
                                        >
                                            <StarIcon
                                                className={cn(
                                                    'size-5',
                                                    isFavorited && 'fill-warning'
                                                )}
                                            />
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    </ListboxItem>
                )
            }}
        </Listbox>
    )
}
