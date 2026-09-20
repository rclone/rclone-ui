import { separatorForOs } from '@/lib/format'
import { setHostProvider } from '@/lib/paths'
import pRetry from 'p-retry'
import type {
    OpenApiMethodResponse,
    OpenApiClient,
    OpenApiClientPathsWithMethod,
    OpenApiMaybeOptionalInit,
    OpenApiRequiredKeysOf,
    RCDClient,
} from 'rclone-sdk'
import { handleReconnectIfNeeded } from './health'
import { rcClient } from '@/server/rc'
import { boot } from '@/server/boot'
import { UserCancelledError } from '@/lib/errors'

let client: RCDClient | null = null

// Every request goes through the server's `/api/rc` proxy, which knows the daemon's address
// and credentials.
function getClient() {
    if (!client) {
        client = rcClient()
    }
    return client
}

export function clearClient() {
    client = null
}

/**
 * The OS of the machine the daemon runs on, which is what paths are built for. It is the machine
 * serving the page — the server runs rclone beside itself — never the browser's. Rust's OS name
 * is wider than these three (freebsd, …), so anything else reads as linux.
 */
export function currentHostOs(): 'windows' | 'macos' | 'linux' {
    const platform = boot.os.platform
    return platform === 'windows' || platform === 'macos' ? platform : 'linux'
}

/** The daemon's path separator: its OS decides, not the browser's. */
export function hostSeparator(): '/' | '\\' {
    return separatorForOs(currentHostOs())
}

export function isHostWindows(): boolean {
    return hostSeparator() === '\\'
}

// The path grammar's one bit of context: whether the host has drives.
setHostProvider(() => ({ windows: isHostWindows() }))

type ClientPaths<T> = T extends OpenApiClient<infer P, any> ? P : never
type Paths = ClientPaths<RCDClient>
type InitParam<Init> = OpenApiRequiredKeysOf<Init> extends never
    ? [(Init & { [key: string]: unknown })?]
    : [Init & { [key: string]: unknown }]

type RequestResult = {
    error?: unknown
    data?: unknown
    response: Response
}

// The transport under `rclone()`: client acquisition and the three-branch error triage. (There
// was an async twin of it; every transfer now starts on the server, `server/transfers.ts`.)
async function request(path: string, init: any[]): Promise<unknown> {
    console.log('[rclone] REQUEST', path, {
        params: init[0]?.params,
        body: init[0]?.body,
    })

    const client = await pRetry(() => getClient(), {
        'maxTimeout': 500,
    }) //! for some reason this still fails sometimes

    if (!client) {
        console.error('[rclone] ERROR: Failed to get client after retries', path)
        throw new Error('Failed to get client after retries')
    }

    const result = (await client.POST(path as any, ...(init as [any]))) as RequestResult

    if (result?.error) {
        console.error('[rclone] ERROR', path, { error: result.error })
        const errMsg =
            typeof result.error === 'string' ? result.error : JSON.stringify(result.error)

        const cancelled = await handleReconnectIfNeeded(errMsg)
        throw cancelled ? new UserCancelledError(errMsg) : new Error(errMsg)
    }

    const data = result.data as { error?: unknown } | undefined
    if (data?.error) {
        console.error('[rclone] DATA ERROR', path, { error: data.error })
        const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)

        const cancelled = await handleReconnectIfNeeded(errMsg)
        throw cancelled ? new UserCancelledError(errMsg) : new Error(errMsg)
    }

    if (!result.response.ok) {
        console.error('[rclone] HTTP ERROR', path, {
            status: result.response.status,
            statusText: result.response.statusText,
        })
        throw new Error(`${result.response.status} ${result.response.statusText}`)
    }

    console.log('[rclone] RESPONSE', path, { hasData: !!result.data })

    return result.data
}

export default async function rclone<
    Path extends OpenApiClientPathsWithMethod<RCDClient, 'post'>,
    Init extends OpenApiMaybeOptionalInit<Paths[Path], 'post'> = OpenApiMaybeOptionalInit<
        Paths[Path],
        'post'
    >,
>(
    path: Path,
    ...init: InitParam<Init>
): Promise<OpenApiMethodResponse<RCDClient, 'post', Path, Init>> {
    return (await request(path, init)) as OpenApiMethodResponse<RCDClient, 'post', Path, Init>
}
