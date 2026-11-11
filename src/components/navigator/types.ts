export type SelectItem = { path: string; type: 'file' | 'folder' }

export type Sort = {
    column: 'name' | 'size' | 'modTime'
    direction: 'ascending' | 'descending'
}

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

/**
 * A row as the list renders it. Anything that can change while the listing stays the same is
 * stored on the row itself. The collection rebuilds only when these objects change, so a flag
 * read from a prop would keep the value (and the handler) that the row was first rendered with.
 */
export type VirtualizedEntry = Entry & { isSelected: boolean; isFavorited: boolean }

/**
 * The sections that the sidebar offers. `LOCAL_FS` is the roots of the local disks and external
 * volumes. `LOCAL_FS_EXTRA` adds the home folder and the user's standard folders (Desktop,
 * Documents, Downloads, Music, Pictures and Movies).
 */
export type AllowedKey = 'REMOTES' | 'LOCAL_FS' | 'LOCAL_FS_EXTRA' | 'FAVORITES'

export type FilePanelHandle = {
    refresh: () => void
    getSelection: () => SelectItem[]
    clearSelection: () => void
    deselect: (keys: string[]) => void
    selectAll: (type: 'files' | 'folders' | 'all') => void
    getCurrentPath: () => { remote: RemoteString; path: string }
    navigateUp: () => void
    /** Puts the focus in the search field, when the panel shows one. */
    focusSearch: () => void
    /** Opens the folder at a full path, as typing it in the path field does. */
    openPath: (path: string) => void
}
