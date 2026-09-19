export type SelectItem = { path: string; type: 'file' | 'folder' }

export type RemoteString = string | 'UI_LOCAL_FS' | 'UI_FAVORITES' | null

export type Entry = {
    key: string
    name: string
    displayName?: string
    isDir: boolean
    size?: number
    modTime?: string
    mimeType?: string
    remote?: string | 'UI_LOCAL_FS'
    fullPath: string
}

export type PaddingItem = {
    key: string
    padding: true
}

export type VirtualizedEntry = Entry & { isSelected: boolean }

/**
 * What the sidebar offers. `LOCAL_FS` is the local disk's roots and external volumes;
 * `LOCAL_FS_EXTRA` adds the user's shortcut folders (home, Desktop, Documents, Downloads).
 */
export type AllowedKey = 'REMOTES' | 'LOCAL_FS' | 'LOCAL_FS_EXTRA' | 'FAVORITES'

export type FilePanelHandle = {
    refresh: () => void
    getSelection: () => SelectItem[]
    clearSelection: () => void
    deselect: (keys: string[]) => void
    selectAll: (type: 'files' | 'folders' | 'all') => void
    navigate: (remote: string, path: string) => void
    getCurrentPath: () => { remote: RemoteString; path: string }
}
