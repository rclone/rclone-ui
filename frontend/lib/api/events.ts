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

export interface AddTemplatePayload {
    cmd?: string
    name?: string
}

export interface WindowEvent {
    label: string
    focused?: boolean
    x?: number
    y?: number
}

export interface EventPayloads {
    'lifecycle.phase': LifecyclePhase
    'state.changed': StateChanged
    'rclone.download-progress': DownloadProgress
    'rclone.download-finished': DownloadProgress
    /** The template a deep link or a shared URL asks to add. */
    'deep-link.add-template': AddTemplatePayload
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
