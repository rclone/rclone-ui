// Bus events the server publishes to every page (src-shared: `Events::emit`). Typed names for
// the ones pages listen to; `on` accepts any name.

import { onEvent } from './ws'

export interface LifecyclePhase {
    phase:
        | 'stopped'
        | 'resolving'
        | 'downloading'
        | 'updating'
        | 'starting'
        | 'ready'
        | 'needsPassword'
        | 'failed'
    version?: string
    from?: string
    to?: string
    pid?: number
    port?: number
    updated?: boolean
    configId?: string
    label?: string
    error?: string
    attempts?: number
    fatal?: boolean
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
    'tunnel.changed': { url: string; user?: string; pass?: string } | null
    'deep-link.add-template': AddTemplatePayload
    'window.focus': WindowEvent
    'window.blur': WindowEvent
    'window.moved': WindowEvent
    'theme.changed': { theme: 'light' | 'dark' }
    'toolbar.shown': { label: string }
    /** The server wrote a line about a transfer: it started, or it ended. */
    'transfers.changed': { hostId: string; id: string }
    /** A window that is already open was asked for again, with this route. */
    'window.route': { label: string; route: string }
}

export function on<N extends keyof EventPayloads>(
    name: N,
    handler: (payload: EventPayloads[N]) => void
): () => void
export function on(name: string, handler: (payload: unknown) => void): () => void
export function on(name: string, handler: (payload: any) => void): () => void {
    return onEvent(name, handler)
}
