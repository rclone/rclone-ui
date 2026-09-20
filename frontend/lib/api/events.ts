// Bus events the server publishes to every page (`Events::emit`). Typed names for
// the ones pages listen to; `on` accepts any name.

import { onEvent } from './ws'

export interface LifecyclePhase {
    phase: 'stopped' | 'resolving' | 'downloading' | 'updating' | 'starting' | 'ready' | 'failed'
    version?: string
    from?: string
    to?: string
    pid?: number
    port?: number
    updated?: boolean
    error?: string
    attempts?: number
}

export interface StateChanged {
    doc: string
    revision: number
    keys: string[]
}

export interface DownloadProgress {
    version: string
    downloaded: number
    total: number | null
}

export interface EventPayloads {
    'lifecycle.phase': LifecyclePhase
    'state.changed': StateChanged
    'rclone.download-progress': DownloadProgress
    /** The server wrote a line about a transfer: it started, or it ended. */
    'transfers.changed': { id: string }
}

export function on<N extends keyof EventPayloads>(
    name: N,
    handler: (payload: EventPayloads[N]) => void
): () => void
export function on(name: string, handler: (payload: unknown) => void): () => void
export function on(name: string, handler: (payload: any) => void): () => void {
    return onEvent(name, handler)
}
