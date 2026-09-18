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
