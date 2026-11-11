import {
    Button,
    DrawerBody,
    DrawerContent,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Cursor as CursorIcon, Xmark as XmarkIcon } from '@zappicon/react'
import { useCallback, useRef, useState } from 'react'
import { formatNumber } from '../../lib/format'
import { baseName } from '../../lib/paths'
import { platform } from '../../lib/shell'
import ContentDrawer from './ContentDrawer'
import { FilePanel, type FilePanelHandle, useEntryActions } from './navigator'
import { TIP, type ToolbarButtons } from './navigator/PanelToolbar'
import type { AllowedKey, Entry, SelectItem } from './navigator/types'
import { panelFolder, placeOf } from './navigator/utils'

export type PickMode = 'both' | 'folders'

export default function PathSelector({
    onClose,
    onSelect,
    initialPaths = [],
    isOpen = true,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES'],
    mode = 'both',
    allowMultiple = true,
}: {
    onClose: () => void
    /**
     * Receives the picked items, and the folder that the picker showed when they were picked
     * (null on Favorites and the list of disks, which aren't folders).
     */
    onSelect?: (items: SelectItem[], shown: string | null) => void
    initialPaths?: string[]
    isOpen?: boolean
    allowedKeys?: AllowedKey[]
    mode?: PickMode
    allowMultiple?: boolean
}) {
    const allowFiles = mode !== 'folders'
    const panelRef = useRef<FilePanelHandle>(null)
    const [selectedCount, setSelectedCount] = useState(0)
    const [currentRemote, setCurrentRemote] = useState<string | null>(null)
    const [currentPath, setCurrentPath] = useState<string>('')
    const [isFavorites, setIsFavorites] = useState(false)

    const handleSelectionChange = useCallback((selected: SelectItem[]) => {
        setSelectedCount(selected.length)
    }, [])

    // A renamed or deleted row is removed from the selection. The listing refreshes on its own.
    const { rename, remove } = useEntryActions(
        useCallback((entry: Entry) => {
            panelRef.current?.deselect([entry.key])
        }, [])
    )

    const handleNavigate = useCallback((remote: string, path: string) => {
        setCurrentRemote(remote)
        setCurrentPath(path)
        setIsFavorites(remote === 'UI_FAVORITES')
    }, [])

    // The folder shown can be picked only when it is a real folder. Favorites and the list of
    // disks are not, so nothing is picked there.
    const currentFolder = panelFolder(currentRemote, currentPath)
    // The menu item that picks the folder shows its name, or the remote's name at the top of a
    // remote. At the top of this computer it says "root".
    const folderName =
        baseName(currentPath) ||
        (currentRemote && currentRemote !== 'UI_LOCAL_FS' && currentRemote !== 'UI_FAVORITES'
            ? currentRemote.split(',')[0]
            : undefined)
    const currentFolderLabel = folderName
        ? t`Current Folder (${folderName})`
        : t`Current Folder (root)`
    const picked = formatNumber(selectedCount)

    const handleConfirm = useCallback(() => {
        if (!panelRef.current) return
        const selection = panelRef.current.getSelection()
        onSelect?.(selection, currentFolder)
    }, [onSelect, currentFolder])

    const handleSelectCurrentFolder = useCallback(() => {
        if (currentFolder === null) return
        onSelect?.([{ path: currentFolder, type: 'folder' }], currentFolder)
    }, [currentFolder, onSelect])

    // The panel opens at the first path. If that folder can't be listed, the panel shows an
    // error, but the sidebar still works. With no path, the panel opens in the home folder.
    const firstPath = initialPaths[0]
    const initialPlace = firstPath ? placeOf(firstPath) : undefined
    const initialRemote = initialPlace?.remote
    const initialPath = initialPlace?.cwd

    const renderToolbar = useCallback(
        (buttons: ToolbarButtons) => [
            [
                buttons.BackButton,
                buttons.RefreshButton,
                <Tooltip key="dismiss-tooltip" content={t`Close this window (Esc)`} {...TIP}>
                    <Button
                        color="danger"
                        size="sm"
                        radius="full"
                        isIconOnly={true}
                        onPress={onClose}
                    >
                        <XmarkIcon className="size-4" />
                    </Button>
                </Tooltip>,
            ],
            [
                buttons.SearchInput,
                buttons.NewFolderButton,
                ...(allowMultiple
                    ? [
                          <Tooltip key="select-dropdown-tooltip" content={t`Select items`} {...TIP}>
                              <div>
                                  <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                                      <DropdownTrigger>
                                          <Button
                                              color="primary"
                                              size="sm"
                                              radius="full"
                                              isIconOnly={true}
                                          >
                                              <CursorIcon className="size-4" />
                                          </Button>
                                      </DropdownTrigger>
                                      <DropdownMenu
                                          color="primary"
                                          disabledKeys={
                                              currentFolder === null ? ['select-current'] : []
                                          }
                                      >
                                          <DropdownItem
                                              key="select-current"
                                              onPress={handleSelectCurrentFolder}
                                          >
                                              {currentFolderLabel}
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-files"
                                              onPress={() => panelRef.current?.selectAll('files')}
                                          >
                                              <Trans>All Files</Trans>
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-folders"
                                              onPress={() => panelRef.current?.selectAll('folders')}
                                          >
                                              <Trans>All Folders</Trans>
                                          </DropdownItem>
                                          <DropdownItem
                                              key="select-files-folders"
                                              onPress={() => panelRef.current?.selectAll('all')}
                                          >
                                              <Trans>All Files & Folders</Trans>
                                          </DropdownItem>
                                          <DropdownItem
                                              key="deselect-all"
                                              onPress={() => panelRef.current?.clearSelection()}
                                              color="danger"
                                          >
                                              <Trans>Deselect all</Trans>
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
                        content={selectedCount === 0 ? t`Tap a checkbox to select items` : ''}
                        {...TIP}
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
                                {selectedCount === 0
                                    ? t`0 SELECTED`
                                    : t({
                                          message: `PICK (${picked})`,
                                          comment:
                                              'Button: picks the selected items. {picked} is how many.',
                                      })}
                            </Button>
                        </div>
                    </Tooltip>
                ) : (
                    <Button
                        key="pick-button"
                        size="sm"
                        color="primary"
                        radius="full"
                        onPress={selectedCount === 0 ? handleSelectCurrentFolder : handleConfirm}
                        isDisabled={selectedCount === 0 && currentFolder === null}
                    >
                        {selectedCount === 0
                            ? t`PICK CURRENT FOLDER`
                            : t({ message: 'PICK', comment: 'Button: picks the selected item.' })}
                    </Button>
                ),
            ],
        ],
        [
            handleSelectCurrentFolder,
            currentFolder,
            currentFolderLabel,
            onClose,
            selectedCount,
            picked,
            allowMultiple,
            handleConfirm,
        ]
    )

    return (
        <ContentDrawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
            // The drawer is full-screen, so the only thing outside it to click is the underlay
            // of the preview drawer inside it. That click must close only the preview.
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
                            allowMultiple={allowMultiple}
                            onSelectionChange={handleSelectionChange}
                            onNavigate={handleNavigate}
                            allowedKeys={allowedKeys}
                            onRename={rename}
                            onDelete={remove}
                            renderToolbar={renderToolbar}
                            toolbarVisible={!isFavorites}
                            isActive={isOpen}
                        />
                    </DrawerBody>
                )}
            </DrawerContent>
        </ContentDrawer>
    )
}
