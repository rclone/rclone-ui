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
import { platform } from '@tauri-apps/plugin-os'
import { MousePointerIcon, XIcon } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import {
    FilePanel,
    type FilePanelHandle,
    RE_PATH_SEPARATOR,
    type SelectItem,
    type ToolbarButtons,
    serializeRemotePath,
} from './navigator'

export default function PathSelector({
    onClose,
    onSelect,
    initialPaths = [],
    isOpen = true,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'FAVORITES'],
    allowFiles = true,
    allowMultiple = true,
}: {
    onClose: () => void
    onSelect?: (items: SelectItem[]) => void
    initialPaths?: string[]
    isOpen?: boolean
    allowedKeys?: ('REMOTES' | 'LOCAL_FS' | 'FAVORITES')[]
    allowFiles?: boolean
    allowMultiple?: boolean
}) {
    const panelRef = useRef<FilePanelHandle>(null)
    const [selectedCount, setSelectedCount] = useState(0)
    const [currentRemote, setCurrentRemote] = useState<string | null>(null)
    const [currentPath, setCurrentPath] = useState<string>('')
    const [isFavorites, setIsFavorites] = useState(false)

    const handleSelectionChange = useCallback((selected: SelectItem[]) => {
        setSelectedCount(selected.length)
    }, [])

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

    const initialRemote = initialPaths[0]?.includes(':/')
        ? initialPaths[0].split(':/')[0]
        : initialPaths.length > 0
          ? 'UI_LOCAL_FS'
          : undefined

    const initialPath = initialPaths[0]?.includes(':/')
        ? initialPaths[0].split(':/').slice(1).join('/')
        : initialPaths[0]
          ? undefined // Will be computed by the hook based on parent
          : undefined

    const renderToolbar = useCallback(
        (buttons: ToolbarButtons) => [
            [
                buttons.BackButton,
                buttons.RefreshButton,
                buttons.HiddenFilesButton,
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
                                  <Dropdown
                                      shadow={platform() === 'windows' ? 'none' : undefined}
                                  >
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
                              <DropdownMenu color="primary">
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
