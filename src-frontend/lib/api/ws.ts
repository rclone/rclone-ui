// The page's WebSocket to the server: stream events for RPCs the page started (`stream` ids)
// and every bus event (`{type:'event', name, payload}`). Reconnects with backoff; a session id
// identifies this page on every RPC (`X-RcloneUI-Session`) so the server knows which socket a
// stream belongs to.

export const sessionId: string =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`

type StreamHandler = { onEvent: (event: unknown) => void; onEnd: (error?: string) => void }
type EventHandler = (payload: unknown) => void

const streams = new Map<string, StreamHandler>()
const eventHandlers = new Map<string, Set<EventHandler>>()
const reconnectListeners = new Set<() => void>()

let socket: WebSocket | null = null
let reconnectDelay = 500
let readyResolvers: (() => void)[] = []
let isReady = false
let everConnected = false
let onUnauthorized: () => void = () => {}

export function setUnauthorizedHandler(handler: () => void) {
    onUnauthorized = handler
}

export function newStreamId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function registerStream(id: string, handler: StreamHandler): () => void {
    streams.set(id, handler)
    return () => streams.delete(id)
}

/** Subscribes to a bus event by name. */
export function onEvent(name: string, handler: EventHandler): () => void {
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

/** Resolves once the socket has said hello (so a stream registered now will be delivered). */
export function whenReady(): Promise<void> {
    if (isReady) return Promise.resolve()
    connect()
    return new Promise((resolve) => readyResolvers.push(resolve))
}

interface Frame {
    type: string
    id?: string
    event?: unknown
    error?: string
    name?: string
    payload?: unknown
}

function handleFrame(frame: Frame) {
    switch (frame.type) {
        case 'ready': {
            reconnectDelay = 500
            const reconnected = everConnected
            everConnected = true
            isReady = true
            for (const resolve of readyResolvers) resolve()
            readyResolvers = []
            if (reconnected) {
                for (const listener of reconnectListeners) listener()
            }
            return
        }
        case 'stream': {
            if (frame.id) streams.get(frame.id)?.onEvent(frame.event)
            return
        }
        case 'stream_end': {
            if (frame.id) {
                const handler = streams.get(frame.id)
                streams.delete(frame.id)
                handler?.onEnd(frame.error)
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

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', session: sessionId }))
    }
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
        isReady = false
        socket = null
        if (!hadReady) {
            // Probably unauthenticated (the server refuses the upgrade): don't hammer it.
            reconnectDelay = Math.min(reconnectDelay * 2, 10000)
            if (everConnected === false) {
                fetch('/api/session', { credentials: 'same-origin' })
                    .then((r) => r.json() as Promise<{ required: boolean; authenticated: boolean }>)
                    .then((session) => {
                        if (session.required && !session.authenticated) onUnauthorized()
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
