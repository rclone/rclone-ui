import { separatorForOs } from '../format'
import { setHostProvider } from '../paths'
import pRetry from 'p-retry'
import type {
    OpenApiMethodResponse,
    OpenApiClient,
    OpenApiClientPathsWithMethod,
    OpenApiMaybeOptionalInit,
    OpenApiRequiredKeysOf,
    RCDClient,
} from 'rclone-sdk'
import { claimReconnectDialog, releaseReconnectDialog } from '../api/app'
import { reconnectTarget } from './reconnect'
import { ask, message } from '../api/dialog'
import { rcClient } from '../api/rc'
import { selectCurrentHost, usePersistedStore } from '../../store/persisted'
import { UserCancelledError } from '../errors'

type ReconnectHandler = (remoteName: string) => Promise<void>
let reconnectHandler: ReconnectHandler | null = null

/**
 * Who runs a remote's login again when a request says it must be reconnected. Set at
 * composition (`src/main.tsx`) to `reconnectRemote`, so this module never imports the API
 * layer that imports it.
 */
export function setReconnectHandler(handler: ReconnectHandler) {
    reconnectHandler = handler
}

// Returns true when the user declined to reconnect (dismissed the prompt or the reconnect attempt
// failed) so callers can abort retries instead of re-running and re-prompting.
// Exported for the one rclone failure that does not come through this client: a transfer's
// launch, which the server runs and answers for (`transfers_start`).
export async function handleReconnectIfNeeded(errorMessage: string) {
    const remoteName = reconnectTarget(errorMessage)
    if (!remoteName) return false
    const host = currentHostId()
    // One dialog app-wide: the server hands the claim to the first page that asks. It is given
    // back below, so the next time this remote's token expires it can ask again.
    if (!(await claimReconnectDialog(host, remoteName).catch(() => true))) return true
    try {
        return await runReconnect(remoteName)
    } finally {
        await releaseReconnectDialog(host, remoteName).catch((error) =>
            console.warn('[reconnect] releasing the dialog claim failed', error)
        )
    }
}

/** The dialog itself, from the offer to the outcome. Returns true when nothing was reconnected. */
async function runReconnect(remoteName: string) {
    const confirmed = await ask(
        `Remote "${remoteName}" needs to be reconnected. This usually means the authentication token has expired.\n\nWould you like to reconnect now?`,
        {
            title: 'Reconnect Remote',
            kind: 'warning',
            okLabel: 'Reconnect',
            cancelLabel: 'Dismiss',
        }
    )
    if (!confirmed) return true
    try {
        if (!reconnectHandler) throw new Error('no reconnect handler is registered')
        await reconnectHandler(remoteName)
        await message(`Remote "${remoteName}" has been reconnected successfully.`, {
            title: 'Reconnected',
            kind: 'info',
        })
        return false
    } catch (err) {
        // The user stopped the login from the sign-in dialog: nothing to report.
        if (err instanceof UserCancelledError) return true
        await message(err instanceof Error ? err.message : 'Reconnection failed', {
            title: 'Reconnect Error',
            kind: 'error',
        })
        return true
    }
}

let client: RCDClient | null = null

// Every request goes through the server's `/api/rc/<hostId>` proxy, which knows the daemon's
// address and credentials; the page only picks the host.
function getClient() {
    if (!client) {
        const currentHost = selectCurrentHost(usePersistedStore.getState())
        if (!currentHost) {
            console.error('[rclone] No current host')
            throw new Error('No current host')
        }
        client = rcClient(currentHost.id)
    }
    return client
}

export function clearClient() {
    client = null
}

/** The host id the client currently targets. */
export function currentHostId(): string {
    return selectCurrentHost(usePersistedStore.getState())?.id ?? 'local'
}

/** The selected host's OS (the machine the daemon runs on), not the one serving the page. */
export function currentHostOs(): 'windows' | 'macos' | 'linux' {
    return selectCurrentHost(usePersistedStore.getState())?.os ?? 'linux'
}

/** The selected host's path separator: its OS decides, not the machine serving the page. */
export function hostSeparator(): '/' | '\\' {
    return separatorForOs(currentHostOs())
}

export function isHostWindows(): boolean {
    return hostSeparator() === '\\'
}

// The path grammar's one bit of context: whether the host has drives. Read on every call, so a
// host switch is followed without anything being told.
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
// was an async twin of it; every transfer now starts on the server, `lib/api/transfers.ts`.)
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
