// `rpc(name, args)` → `POST /api/rpc/<name>`. Streaming
// commands take a client-generated `stream` id and deliver their events over the WebSocket.

import { newStreamId, registerStream, sessionId, setUnauthorizedHandler, whenReady } from './ws'

const SESSION_HEADER = 'X-RcloneUI-Session'

export class RpcError extends Error {
    constructor(
        message: string,
        public readonly command: string
    ) {
        super(message)
        this.name = 'RpcError'
    }
}

let unauthorizedHandled = false
function handleUnauthorized() {
    if (unauthorizedHandled) return
    unauthorizedHandled = true
    if (window.location.pathname !== '/login') window.location.assign('/login')
}
setUnauthorizedHandler(handleUnauthorized)

async function post(
    path: string,
    headers: Record<string, string>,
    body: BodyInit
): Promise<Response> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { [SESSION_HEADER]: sessionId, ...headers },
        body,
        credentials: 'same-origin',
    })
    if (response.status === 401) {
        handleUnauthorized()
        throw new RpcError('unauthorized', path)
    }
    return response
}

async function parse<T>(command: string, response: Response): Promise<T> {
    const text = await response.text()
    let parsed: { ok: boolean; value?: T; error?: string }
    try {
        parsed = JSON.parse(text) as { ok: boolean; value?: T; error?: string }
    } catch {
        throw new RpcError(
            `${command}: unexpected response (${response.status}): ${text.slice(0, 200)}`,
            command
        )
    }
    if (!parsed.ok) {
        throw new RpcError(parsed.error ?? `${command} failed`, command)
    }
    return parsed.value as T
}

/** Calls a command with JSON arguments. */
export async function rpc<T = unknown>(
    command: string,
    args?: Record<string, unknown>
): Promise<T> {
    const response = await post(
        `/api/rpc/${encodeURIComponent(command)}`,
        { 'Content-Type': 'application/json' },
        JSON.stringify(args ?? {})
    )
    return parse<T>(command, response)
}

export interface StreamHandle<T> {
    /** The command's own return value. */
    result: T
    /** Resolves when the producer ends the stream (rejects with its error). */
    done: Promise<void>
    /** Stops delivering events to `onEvent` (the producer may keep running). */
    unsubscribe: () => void
}

/**
 * Starts a streaming command: registers `onEvent` for a fresh stream id, then invokes the
 * command with `stream` in its arguments.
 */
export async function stream<T = unknown, E = unknown>(
    command: string,
    args: Record<string, unknown>,
    onEvent: (event: E) => void
): Promise<StreamHandle<T>> {
    await whenReady()
    const id = newStreamId()
    let resolveDone: () => void = () => {}
    let rejectDone: (error: Error) => void = () => {}
    const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
    })
    done.catch(() => {})
    const unsubscribe = registerStream(id, {
        onEvent: (event) => onEvent(event as E),
        onEnd: (error) => (error ? rejectDone(new RpcError(error, command)) : resolveDone()),
    })
    try {
        const result = await rpc<T>(command, { ...args, stream: id })
        return { result, done, unsubscribe }
    } catch (error) {
        unsubscribe()
        rejectDone(error instanceof Error ? error : new Error(String(error)))
        throw error
    }
}
