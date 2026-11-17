import { platform } from '@tauri-apps/plugin-os'
import pRetry from 'p-retry'
import createRCDClient from 'rclone-sdk'
import { getAuthHeader, rcFetch } from './rclone/session'

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

// The rclone RC daemon port. Keep in sync with the hardcoded port in the Rust
// start_cloudflared_tunnel command.
export const RC_PORT = 5572
export const RC_LOCAL_URL = `http://localhost:${RC_PORT}`

/** The canonical local-machine host, used as the fallback whenever no reachable host is selected. */
export function makeLocalHost(): Host {
    const os = platform()
    return {
        id: LOCAL_HOST_ID,
        name: 'Local Machine',
        url: RC_LOCAL_URL,
        // platform() is wider than Host['os'] (ios/android/freebsd/...); desktop builds only see
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
    id,
    url,
    authUser,
    authPassword,
}: {
    id?: Host['id']
    url: string
    authUser?: string
    authPassword?: string
}) {
    try {
        const parsedUrl = new URL(url)
        if (!parsedUrl.hostname) {
            return null
        }
    } catch {
        return null
    }

    const authHeader = await getAuthHeader({ id, authUser, authPassword })

    const rcloneClient = createRCDClient({
        baseUrl: url,
        headers: authHeader
            ? {
                  'Authorization': authHeader,
              }
            : undefined,
        fetch: (request: Request) => rcFetch(request),
    })

    console.log('[getHostInfo] rcloneClient', rcloneClient)

    const infoResponse = await pRetry(
        () =>
            rcloneClient.POST('/core/version').then((res) => {
                if (!res || !res.data || res.error) {
                    throw new Error('Failed to get rclone version')
                }
                return res.data
            }),
        {
            retries: 3,
            factor: 2,
            minTimeout: 1000,
            maxTimeout: 10000,
        }
    )

    console.log('[getHostInfo] infoResponse', infoResponse)

    const { os, version } = infoResponse

    const cleanedVersion = version.replace(/^v/, '')
    const parsedOs = os === 'windows' ? 'windows' : os === 'darwin' ? 'macos' : 'linux'

    return {
        cliVersion: cleanedVersion,
        os: parsedOs,
    } as const
}
