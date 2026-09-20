import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'

import { MousePointerIcon, XIcon } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { FilePanel, type FilePanelHandle, useEntryActions } from './navigator'
import type { ToolbarButtons } from './navigator/PanelToolbar'
import type { AllowedKey, Entry, SelectItem } from './navigator/types'
import { RE_PATH_SEPARATOR, RE_TRAILING_SEPARATORS, serializeRemotePath } from './navigator/utils'
import { parsePath } from '@/lib/paths'

export type PickMode = 'both' | 'files' | 'folders'

export default function PathSelector({
    onClose,
    onSelect,
    initialPaths = [],
    isOpen = true,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES'],
    mode = 'both',
    allowMultiple = true,
    allowEdits = true,
}: {
    onClose: () => void
    onSelect?: (items: SelectItem[]) => void
    initialPaths?: string[]
    isOpen?: boolean
    allowedKeys?: AllowedKey[]
    /** What the picker may return: `files` never hands back a folder, `folders` lists none. */
    mode?: PickMode
    allowMultiple?: boolean
    /** Rename and delete on the rows, as in the Commander; off for a picker that must only choose. */
    allowEdits?: boolean
}) {
    const allowFiles = mode !== 'folders'
    const allowFolderSelection = mode !== 'files'
    const panelRef = useRef<FilePanelHandle>(null)
    const [selectedCount, setSelectedCount] = useState(0)
    const [currentRemote, setCurrentRemote] = useState<string | null>(null)
    const [currentPath, setCurrentPath] = useState<string>('')
    const [isFavorites, setIsFavorites] = useState(false)

    const handleSelectionChange = useCallback((selected: SelectItem[]) => {
        setSelectedCount(selected.length)
    }, [])

    // A renamed or deleted row leaves the selection before the listing is refreshed.
    const { rename, remove } = useEntryActions(
        useCallback((entry: Entry) => {
            panelRef.current?.deselect([entry.key])
            panelRef.current?.refresh()
        }, [])
    )

    const handleNavigate = useCallback((remote: string, path: string) => {
        setCurrentRemote(remote)
        setCurrentPath(path)
        setIsFavorites(remote === 'UI_FAVORITES')
    }, [])

    const handleConfirm = useCallback(() => {
        if (!panelRef.current) return
        const selection = panelRef.current.getSelection()
        onSelect?.(selection)
    }, [onSelect])

    const handleSelectCurrentFolder = useCallback(() => {
        if (!currentRemote) return
        let path = currentPath
        if (currentRemote !== 'UI_LOCAL_FS' && currentRemote !== 'UI_FAVORITES') {
            path = serializeRemotePath(currentRemote, currentPath)
        }
        onSelect?.([{ path, type: 'folder' }])
    }, [currentRemote, currentPath, onSelect])

    // A remote root ("gdrive:") counts as a remote path. A local path opens the panel in that
    // folder (a folder that cannot be listed shows the panel's error; the sidebar still works);
    // no path at all opens at home.
    const firstPath = initialPaths[0]
    const parsedFirst = firstPath ? parsePath(firstPath) : undefined
    const isRemoteInitial = parsedFirst?.kind === 'remote' && parsedFirst.name !== ':local'
    const initialRemote = isRemoteInitial ? parsedFirst.name : firstPath ? 'UI_LOCAL_FS' : undefined
    // The directory as it was spelled: a leading slash is the absolute root and stays.
    const initialPath = isRemoteInitial
        ? parsedFirst.path.replace(RE_TRAILING_SEPARATORS, '')
        : firstPath || undefined

    const renderToolbar = useCallback(
        (buttons: ToolbarButtons) => [
            [
                buttons.BackButton,
                buttons.RefreshButton,
                <Tooltip
                    key="dismiss-tooltip"
                    content="Close this window (Esc)"
                    placement="top"
                    size="lg"
                    color="foreground"
                >
                    <Button
                        color="danger"
                        size="sm"
                        radius="full"
                        isIconOnly={true}
                        onPress={onClose}
                    >
                        <XIcon className="size-4" />
                    </Button>
                </Tooltip>,
            ],
            [
                buttons.SearchInput,
                buttons.NewFolderButton,
                ...(allowMultiple
                    ? [
                          <Tooltip
                              key="select-dropdown-tooltip"
                              content="Select items"
                              placement="top"
                              size="lg"
                              color="foreground"
                          >
                              <div>
                                  <Dropdown>
                                      <DropdownTrigger>
                                          <Button
                                              color="primary"
                                              size="sm"
                                              radius="full"
                                              isIconOnly={true}
                                          >
                                              <MousePointerIcon className="size-4" />
                                          </Button>
                                      </DropdownTrigger>
                                      <DropdownMenu
                                          disabledKeys={
                                              mode === 'files'
                                                  ? [
                                                        'select-current',
                                                        'select-folders',
                                                        'select-files-folders',
                                                    ]
                                                  : []
                                          }
                                          color="primary"
                                      >
                                          <DropdownItem
                                              key="select-current"
                                              onPress={handleSelectCurrentFolder}
                                          >
                                              Current Folder (
                                              {currentPath.split(RE_PATH_SEPARATOR).pop() ||
                                                  currentRemote ||
                                                  'root'}
                                              )
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-files"
                                              onPress={() => panelRef.current?.selectAll('files')}
                                          >
                                              All Files
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-folders"
                                              onPress={() => panelRef.current?.selectAll('folders')}
                                          >
                                              All Folders
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-files-folders"
                                              onPress={() => panelRef.current?.selectAll('all')}
                                          >
                                              All Files & Folders
                                          </DropdownItem>
                                          <DropdownItem
                                              key="deselect-all"
                                              onPress={() => panelRef.current?.clearSelection()}
                                              color="danger"
                                          >
                                              Deselect All
                                          </DropdownItem>
                                      </DropdownMenu>
                                  </Dropdown>
                              </div>
                          </Tooltip>,
                      ]
                    : []),
            ],
            [
                allowMultiple ? (
                    <Tooltip
                        key="pick-tooltip"
                        content={selectedCount === 0 ? 'Tap on the checkbox to select items' : ''}
                        placement="top"
                        size="lg"
                        color="foreground"
                        isDisabled={selectedCount > 0}
                    >
                        <div>
                            <Button
                                size="sm"
                                color="primary"
                                radius="full"
                                onPress={handleConfirm}
                                isDisabled={selectedCount === 0}
                            >
                                {selectedCount === 0 ? '0 SELECTED' : `PICK (${selectedCount})`}
                            </Button>
                        </div>
                    </Tooltip>
                ) : mode === 'files' ? (
                    <Button
                        key="pick-button"
                        size="sm"
                        color="primary"
                        radius="full"
                        onPress={handleConfirm}
                        isDisabled={selectedCount === 0}
                    >
                        {selectedCount === 0 ? '0 SELECTED' : 'PICK'}
                    </Button>
                ) : (
                    <Button
                        key="pick-button"
                        size="sm"
                        color="primary"
                        radius="full"
                        onPress={selectedCount === 0 ? handleSelectCurrentFolder : handleConfirm}
                    >
                        {selectedCount === 0 ? 'PICK CURRENT FOLDER' : 'PICK'}
                    </Button>
                ),
            ],
        ],
        [
            handleSelectCurrentFolder,
            currentPath,
            currentRemote,
            onClose,
            selectedCount,
            allowMultiple,
            handleConfirm,
        ]
    )

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
            // Full-screen, so there is nothing outside it to click except the underlay of the
            // preview drawer it hosts; that click must close only the preview.
            isDismissable={false}
        >
            <DrawerContent>
                {() => (
                    <DrawerBody className="flex flex-row w-full gap-0 p-0">
                        <FilePanel
                            ref={panelRef}
                            sidebarPosition="left"
                            initialRemote={initialRemote}
                            initialPath={initialPath}
                            selectionMode="checkbox"
                            allowFiles={allowFiles}
                            allowFolderSelection={allowFolderSelection}
                            allowMultiple={allowMultiple}
                            onSelectionChange={handleSelectionChange}
                            onNavigate={handleNavigate}
                            allowedKeys={allowedKeys}
                            onRename={allowEdits ? rename : undefined}
                            onDelete={allowEdits ? remove : undefined}
                            renderToolbar={renderToolbar}
                            toolbarVisible={!isFavorites}
                            isActive={isOpen}
                            showPreviewColumn={true}
                        />
                    </DrawerBody>
                )}
            </DrawerContent>
        </Drawer>
    )
}
