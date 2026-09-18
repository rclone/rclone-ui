import pRetry from 'p-retry'
import { hostProbe } from './api/app'
import { platform } from './api/os'

export interface Host {
    id: 'local' | string
    name: string
    cliVersion: string
    os: 'windows' | 'macos' | 'linux'
    url: string
    authUser?: string
    authPassword?: string
}

export const LOCAL_HOST_ID = 'local' as const

// The managed daemon's real address belongs to the server: the local host entry keeps a
// placeholder URL for display and pages always reach it through `/api/rc/local`.
export const RC_LOCAL_URL = 'http://localhost:5572'

/** The canonical local-machine host, used as the fallback whenever no reachable host is selected. */
export function makeLocalHost(): Host {
    const os = platform
    return {
        id: LOCAL_HOST_ID,
        name: 'Local Machine',
        url: RC_LOCAL_URL,
        // platform is wider than Host['os'] (ios/android/freebsd/...); desktop builds only see
        // these three — anything else falls back to linux, mirroring getHostInfo's normalization.
        os: os === 'windows' || os === 'macos' ? os : 'linux',
        cliVersion: 'unknown',
    }
}

export const LABEL_FOR_OS = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
} as const

export async function getHostInfo({
    hostId,
    url,
    authUser,
    authPassword,
}: {
    /** `local` probes the managed daemon regardless of `url`. */
    hostId?: string
    url: string
    authUser?: string
    authPassword?: string
}) {
    if (hostId !== LOCAL_HOST_ID) {
        try {
            const parsedUrl = new URL(url)
            if (!parsedUrl.hostname) {
                return null
            }
        } catch {
            return null
        }
    }

    // The server probes the daemon (CORS never applies to it) and normalizes the reply.
    const infoResponse = await pRetry(() => hostProbe({ hostId, url, authUser, authPassword }), {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 10000,
    })

    console.log('[getHostInfo] infoResponse', infoResponse)

    return infoResponse
}
