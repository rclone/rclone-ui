import { rcFetch } from '../api/rc'
import { currentHostId } from './client'

// rclone's own advice when a token cannot be refreshed: "token expired and there's no refresh
// token - manually refresh with \"rclone config reconnect work:\"". It is the only signal there
// is — nothing in the config says whether a refresh token is still good — so both the prompt
// (client.ts) and the Dashboard's check read it from here rather than each keeping a copy.
const RE_RECONNECT = /rclone config reconnect (\S+?):/

/** The remote an error says must be reconnected, or null when it says nothing of the sort. */
export function reconnectTarget(error: unknown): string | null {
    const text =
        typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    return text.match(RE_RECONNECT)?.[1] ?? null
}

export type ReconnectState = 'ok' | 'needs-reconnect' | 'unreachable'

/**
 * Whether a remote can still be used, asked quietly. `operations/fsinfo` connects the remote, so
 * a stale token answers with the advice above.
 *
 * Deliberately not the `rclone()` client: that one offers to reconnect whatever fails, and the
 * Dashboard checking every remote as it opens would throw a dialog at somebody who only wanted
 * to look at the page. `rcFetch` is the same request without that.
 */
export async function probeRemote(remote: string): Promise<ReconnectState> {
    try {
        const response = await rcFetch(currentHostId(), 'operations/fsinfo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fs: `${remote}:` }),
        })
        if (response.ok) return 'ok'
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        // A remote that is merely unreachable (no network, daemon busy) is not one to reconnect,
        // and must not be counted as one.
        return reconnectTarget(body.error) ? 'needs-reconnect' : 'unreachable'
    } catch {
        return 'unreachable'
    }
}

/**
 * Its own key, never `['remote', name, 'fsinfo']`. That one is what the file panel relies on to
 * fail and offer the prompt; a quiet check writing its error there would leave the panel with a
 * cached failure and nothing to offer.
 */
export function reconnectCheckQueryOptions(remote: string) {
    return {
        queryKey: ['remote', remote, 'reconnect-check'] as const,
        queryFn: () => probeRemote(remote),
        staleTime: 1000 * 60 * 60 * 24,
        retry: false,
    }
}
