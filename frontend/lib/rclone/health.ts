import { rcFetch } from '../api/rc'
import queryClient from '../query'

// rclone's own advice when a token cannot be refreshed: "token expired and there's no refresh
// token - manually refresh with \"rclone config reconnect work:\"". It is the only signal there
// is — nothing in the config says whether a refresh token is still good — so both the prompt
// (client.ts) and the health check read it from here rather than each keeping a copy.
const RE_RECONNECT = /rclone config reconnect (\S+?):/

/** The remote an error says must be reconnected, or null when it says nothing of the sort. */
export function reconnectTarget(error: unknown): string | null {
    const text =
        typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    return text.match(RE_RECONNECT)?.[1] ?? null
}

/**
 * Whether a remote works, as the remote cards, the remote editor and the Dashboard show it.
 * `canReconnect` is true only on the remote rclone names: a crypt over a drive whose sign-in
 * lapsed fails with the same advice, and it is the drive that is signed in again.
 */
export type RemoteHealth =
    | { state: 'ok'; about: boolean }
    | { state: 'faulty'; error: string; canReconnect: boolean }

const TIMEOUT_MS = 30_000
const HOUR_MS = 1000 * 60 * 60

// The Dashboard asks about every remote together and the browser gives the origin six
// connections: a few slow remotes would hold up everything else the page asks for.
const AT_ONCE = 3
let running = 0
const waiting: (() => void)[] = []

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
    if (running < AT_ONCE) running += 1
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
        return await work()
    } finally {
        // The slot passes to whoever waits, or is given back.
        const next = waiting.shift()
        if (next) next()
        else running -= 1
    }
}

/** rclone's answer or rclone's error. Throws when it was not rclone that answered. */
async function ask(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal
): Promise<{ data: { Features?: { About?: boolean } } } | { error: string }> {
    const response = await rcFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    })
    const answer = (await response.json().catch(() => null)) as {
        Features?: { About?: boolean }
        error?: unknown
        path?: unknown
    } | null
    if (response.ok && answer) return { data: answer }
    // rclone's error shape is `{error, input, path, status}`. The server's 401 and the proxy's
    // 502/503 carry an `error` too, and say nothing about the remote.
    if (typeof answer?.error === 'string' && typeof answer.path === 'string') {
        return { error: answer.error }
    }
    throw new Error(`${path}: ${response.status}`)
}

/**
 * Opens the remote, then lists its root: an alias to a folder that is not there opens fine, and
 * only a listing says so.
 *
 * Quiet on purpose. The `rclone()` client offers to reconnect whatever fails, and a page that
 * checks every remote as it opens would throw a dialog at somebody who only came to look.
 *
 * Throws when it could not ask (no daemon, a lapsed session, 30 seconds without an answer):
 * that says nothing about the remote, and the last answer stands.
 */
export async function checkRemote(name: string, signal: AbortSignal): Promise<RemoteHealth> {
    return inTurn(async () => {
        // Started here, not when queued: a check must not time out waiting its turn.
        const timed = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        const fs = `${name}:`
        const faulty = (error: string, shown = error): RemoteHealth => ({
            state: 'faulty',
            error: shown,
            // Not `reconnectTarget`, whose `\S+` misreads a name with a space in it.
            canReconnect: error.includes(`rclone config reconnect ${name}:`),
        })

        const opened = await ask('operations/fsinfo', { fs }, timed)
        if ('error' in opened) return faulty(opened.error)

        // `dirsOnly` keeps the answer small (rclone lists the whole root either way) and
        // `noModTime` spares a request per object where a modtime costs one.
        const listed = await ask(
            'operations/list',
            { fs, remote: '', opt: { dirsOnly: true, noModTime: true, noMimeType: true } },
            timed
        )
        if ('error' in listed) return faulty(listed.error, `Cannot list: ${listed.error}`)

        return { state: 'ok', about: !!opened.data.Features?.About }
    })
}

/**
 * After anything that changes a remote. Every remote's answer goes, because a wrapper's health
 * is its base's. `refetch: false` for a list about to remount: its cards ask as they return.
 */
export function forgetRemoteHealth({ refetch = true } = {}) {
    return queryClient.invalidateQueries({
        queryKey: ['remote-health'],
        refetchType: refetch ? 'active' : 'none',
    })
}

/**
 * Its own key family, never `['remote', name, 'fsinfo']`: the file panel relies on that one
 * failing uncached to offer the reconnect prompt.
 */
export function remoteHealthQueryOptions(remote: string) {
    return {
        queryKey: ['remote-health', remote] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) => checkRemote(remote, signal),
        // A fault is asked about again soon, but not each time its card scrolls back into view.
        staleTime: (query: { state: { data?: RemoteHealth } }) =>
            query.state.data?.state === 'ok' ? HOUR_MS : 60_000,
        retry: false,
        // A sign-in leaves the tab and comes back.
        refetchOnWindowFocus: false,
        // rclone's error text can repeat what the config holds: not for the stored cache.
        meta: { persist: false },
    }
}
