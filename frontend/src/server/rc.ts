// rclone's RC API through the server's reverse proxy: `/api/rc/…` reaches the daemon with the
// credentials injected server-side. The page never holds the daemon's password and CORS never
// applies.

import createRCDClient, { type RCDClient } from 'rclone-sdk'

export const RC_BASE = '/api/rc'

/** `/api/rc/<path>` for a `--rc-serve` file path (`[fs]/dir/file`) or an RC endpoint. */
export function rcUrl(path: string): string {
    return `${RC_BASE}/${path.replace(/^\/+/, '')}`
}

export function rcClient(): RCDClient {
    return createRCDClient({
        baseUrl: `${location.origin}${RC_BASE}`,
        fetch: (request: Request) => fetch(request, { credentials: 'same-origin' }),
    })
}

/** A raw request to the daemon through the proxy (uploads, previews, downloads). */
export function rcFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(rcUrl(path), { ...init, credentials: 'same-origin' })
}
