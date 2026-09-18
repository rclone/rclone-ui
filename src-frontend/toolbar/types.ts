import type { fetchMountList, fetchServeList } from '../lib/rclone/api'
import type { RcloneFeatures } from '../types/rclone'

export type ToolbarCommandId =
    | 'copy'
    | 'move'
    | 'sync'
    | 'mount'
    | 'download'
    | 'serve'
    | 'bisync'
    | 'delete'
    | 'purge'
    | 'cleanup'
    | 'browse'
    | 'settings'
    | 'github'
    | 'transfers'
    | 'schedules'
    | 'templates'
    | 'remoteCreate'
    | 'remoteEdit'
    | 'remoteAutoMount'
    | 'quit'
    | 'remoteList'
    | 'vfs'
    | 'commander'

export type ToolbarActionArgs = Record<string, any>

export interface ToolbarActionResult {
    label: string
    description?: string
    args: ToolbarActionArgs
    score?: number
}

export interface ToolbarActionOnPressContext {
    openWindow: (options: { name: string; url: string }) => Promise<unknown>
    updateText: (text: string) => void
}

export interface ToolbarActionPath {
    full: string
    readable: string
    isLocal: boolean
    remoteName?: string
    remoteType?: string
    // Authoritative backend capability set from `operations/fsinfo`; undefined until the probe
    // resolves (or for local paths), in which case capability-gated actions fall to their generic item.
    features?: RcloneFeatures
}

/**
 * What the toolbar knows when it generates results, handed in whole: the results are a function
 * of the query and this snapshot, nothing read from a cache or a store on the way.
 */
export interface ToolbarSnapshot {
    /** The current host is this machine (a mount point can be opened, not only copied). */
    hostIsLocal: boolean
    mounts: Awaited<ReturnType<typeof fetchMountList>>
    serves: Awaited<ReturnType<typeof fetchServeList>>
    vfses: string[]
}

export interface ToolbarActionContext {
    query: string
    fullQuery: string
    paths: ToolbarActionPath[]
    remotes: string[]
    snapshot: ToolbarSnapshot
}

export interface ToolbarActionDefaultContext {
    remotes: string[]
}

export interface ToolbarActionDefinition {
    id: ToolbarCommandId
    label: string
    description?: string
    keywords: string[]
    getResults: (context: ToolbarActionContext) => ToolbarActionResult[]
    getDefaultResult?: (context: ToolbarActionDefaultContext) => ToolbarActionResult
    onPress: (args: ToolbarActionArgs, context: ToolbarActionOnPressContext) => Promise<void> | void
}
