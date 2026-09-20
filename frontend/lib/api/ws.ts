// The page's WebSocket to the server: every bus event, as `{type:'event', name, payload}`. The
// server says `ready` once the socket is up; a page whose socket came back hears of it through
// `onReconnect` and asks its queries again (main.tsx). Reconnects with backoff.

type EventHandler = (payload: unknown) => void

const eventHandlers = new Map<string, Set<EventHandler>>()
const reconnectListeners = new Set<() => void>()

let socket: WebSocket | null = null
let reconnectDelay = 500
let everConnected = false
let onUnauthorized: () => void = () => {}

export function setUnauthorizedHandler(handler: () => void) {
    onUnauthorized = handler
}

function onEvent(name: string, handler: EventHandler): () => void {
    let set = eventHandlers.get(name)
    if (!set) {
        set = new Set()
        eventHandlers.set(name, set)
    }
    set.add(handler)
    return () => {
        set?.delete(handler)
    }
}

/** Fires after every reconnect (pages refetch what they may have missed). */
export function onReconnect(listener: () => void): () => void {
    reconnectListeners.add(listener)
    return () => reconnectListeners.delete(listener)
}

interface Frame {
    type: string
    name?: string
    payload?: unknown
}

function handleFrame(frame: Frame) {
    switch (frame.type) {
        case 'ready': {
            reconnectDelay = 500
            const reconnected = everConnected
            everConnected = true
            if (reconnected) {
                for (const listener of reconnectListeners) listener()
            }
            return
        }
        case 'event': {
            if (!frame.name) return
            const handlers = eventHandlers.get(frame.name)
            if (!handlers) return
            for (const handler of handlers) {
                try {
                    handler(frame.payload)
                } catch (error) {
                    console.error(`[ws] handler for ${frame.name} failed`, error)
                }
            }
            return
        }
        default:
            return
    }
}

export function connect() {
    if (typeof window === 'undefined') return
    if (
        socket &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
        return
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}/api/ws`)
    socket = ws
    let hadReady = false

    ws.onmessage = (message) => {
        let frame: Frame
        try {
            frame = JSON.parse(String(message.data)) as Frame
        } catch {
            return
        }
        if (frame.type === 'ready') hadReady = true
        handleFrame(frame)
    }
    ws.onclose = () => {
        socket = null
        if (!hadReady) {
            // Probably unauthenticated (the server refuses the upgrade): don't hammer it.
            reconnectDelay = Math.min(reconnectDelay * 2, 10000)
            if (everConnected === false) {
                fetch('/api/session', { credentials: 'same-origin' })
                    .then((r) => r.json() as Promise<{ authenticated: boolean }>)
                    .then((session) => {
                        if (!session.authenticated) onUnauthorized()
                    })
                    .catch(() => {})
            }
        }
        setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 10000)
    }
    ws.onerror = () => {
        ws.close()
    }
}

// Keep the socket alive through proxies that drop idle connections.
if (typeof window !== 'undefined') {
    setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
    }, 25_000)
}

// --- the events the server publishes (`Bus::publish`), typed by name ---------------------------

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

export interface UpdateProgress {
    event: 'Started' | 'Progress' | 'Finished'
    data?: { contentLength?: number | null; chunkLength?: number }
}

export interface EventPayloads {
    'lifecycle.phase': LifecyclePhase
    'state.changed': StateChanged
    /** An rclone release on its way into the machine's bin folder. */
    'rclone.download-progress': DownloadProgress
    /** The server's own update on its way in. */
    'app.update.progress': UpdateProgress
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
