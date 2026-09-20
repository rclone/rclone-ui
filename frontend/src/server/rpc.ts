// `rpc(name, args)` → `POST /api/rpc/<name>`. Progress, when an RPC has any, comes over the
// WebSocket as a bus event (`ws.ts`), never through the reply.

import { onEntryScreen } from './session'
import { setUnauthorizedHandler } from './ws'

// The server refuses an RPC without it: a cross-site form cannot set a custom header, so with
// the cookie's SameSite=Strict this is the second wall against a forged request.
export const CLIENT_HEADER = { 'X-RcloneCloud-Client': 'web' }

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
    if (!onEntryScreen()) window.location.assign('/login')
}
setUnauthorizedHandler(handleUnauthorized)

async function post(
    path: string,
    headers: Record<string, string>,
    body: BodyInit
): Promise<Response> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { ...CLIENT_HEADER, ...headers },
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
