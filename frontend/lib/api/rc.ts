// rclone's RC API through the server's reverse proxy: `/api/rc/<hostId>/…` reaches the managed
// daemon (`local`) or a configured remote host, with the credentials injected server-side. The
// page never holds the daemon's password and CORS never applies.

import createRCDClient, { type RCDClient } from 'rclone-sdk'

export function rcBase(hostId: string): string {
    return `/api/rc/${encodeURIComponent(hostId)}`
}

/** `/api/rc/<host>/<path>` for a `--rc-serve` file path (`[fs]/dir/file`) or an RC endpoint. */
export function rcUrl(hostId: string, path: string): string {
    return `${rcBase(hostId)}/${path.replace(/^\/+/, '')}`
}

export function rcClient(hostId: string): RCDClient {
    return createRCDClient({
        baseUrl: `${location.origin}${rcBase(hostId)}`,
        fetch: (request: Request) => fetch(request, { credentials: 'same-origin' }),
    })
}

/** A raw request to a daemon through the proxy (uploads, previews, downloads). */
export function rcFetch(hostId: string, path: string, init?: RequestInit): Promise<Response> {
    return fetch(rcUrl(hostId, path), { ...init, credentials: 'same-origin' })
}
