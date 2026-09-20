// The app's process and platform integration: version, quit/relaunch, self-update, and the
// lifecycle (the rclone daemon the server manages). Starting at boot is the operator's job,
// through whatever supervisor runs the server.

import { rpc } from './rpc'
import { type LifecyclePhase, type UpdateProgress, on } from './ws'

export interface UpdateInfo {
    version: string
    currentVersion: string
    body: string | null
    date: string | null
}

export const relaunch = () => rpc<null>('app_relaunch')
export const updateCheck = () => rpc<UpdateInfo | null>('app_update_check')
/** Installs the update `updateCheck` found; its download reports over the bus meanwhile. */
export async function updateInstall(
    onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
    const off = on('app.update.progress', (event) => onProgress?.(event))
    try {
        await rpc<null>('app_update_install')
    } finally {
        off()
    }
}
/** The dialog is one at a time across pages, per remote. */
export const claimReconnectDialog = (remote: string) =>
    rpc<boolean>('claim_reconnect_dialog', { remote })
export const releaseReconnectDialog = (remote: string) =>
    rpc<null>('release_reconnect_dialog', { remote })

// --- lifecycle ---------------------------------------------------------------------------

export interface Status {
    version: string
    uptimeSeconds: number
    dirs: { data: string }
    managedDaemon: boolean
    lifecycle: LifecyclePhase | null
    daemon: { url: string } | null
}

export async function status(): Promise<Status> {
    const response = await fetch('/api/status', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`status: HTTP ${response.status}`)
    return (await response.json()) as Status
}

export const restartRclone = () => rpc<null>('rclone_restart')

export interface ProxySettings {
    url: string
    ignoredHosts: string[]
}
export interface Limits {
    bwLimit: string
    tpsLimit: number
    tpsLimitBurst: number
}
/**
 * Saves the daemon's proxy and limits on the server, which puts the bandwidth on the running
 * rclone (what judges its syntax; a refused one is not kept) and restarts it when a transaction
 * limit changed. A key left out is left alone; `null` clears it. The store follows through
 * `state.changed`.
 */
export const daemonSettingsSet = (settings: {
    proxy?: ProxySettings | null
    limits?: Limits | null
}) => rpc<null>('daemon_settings_set', settings)

// --- downloads ----------------------------------------------------------------------

export const downloadLink = (fs: string, remote: string) =>
    rpc<string>('download_link', { fs, remote })

// --- third-party fetches the server makes on the page's behalf ---------------------------

/** The stable releases this server can run (at or above its minimum), newest first. */
export const rcloneReleases = (limit: number) =>
    rpc<{ version: string; publishedAt: string }[]>('rclone_releases', { limit })

// --- the rclone binary (Settings › Rclone) ------------------------------------------------

export interface RcloneBinary {
    /** `external`: the daemon is somebody else's (`--rclone-url`), and nothing else is known. */
    kind: 'pinned' | 'custom' | 'system' | 'external' | null
    path?: string | null
    version?: string | null
    /** The custom binary in the settings, in use or not. */
    custom?: string | null
    /** The file an install replaces, or why there is none. */
    installTarget?: string | null
    installBlocked?: string | null
}

export const rcloneBinary = () => rpc<RcloneBinary>('rclone_binary')
/** Replaces the server's own rclone and restarts on it. Resolves to the path it wrote. */
export const rcloneInstall = (version: string) => rpc<string>('rclone_install', { version })
/** `null` goes back to the server's own rclone. One older than the minimum is refused. */
export const rcloneSetCustom = (path: string | null) => rpc<null>('rclone_set_custom', { path })

// --- mounting -----------------------------------------------------------------------------

/** Whether the server's machine can mount; when it cannot, why, and where setting it up is explained. */
export interface MountSupport {
    supported: boolean
    reason?: string
    docs?: string
}

export const mountSupport = () => rpc<MountSupport>('mount_support')

// --- what the server fetches for a page (its machine can reach what the browser cannot) ------

/** What the server's `resolve_link` found behind a page address (a TikTok video, a Drive file). */
export interface ResolvedLink {
    url: string
    filename: string
    type: 'video' | 'audio' | 'file' | 'image'
}

export const resolveLink = (url: string) => rpc<ResolvedLink | null>('resolve_link', { url })

/** One request through `proxyUrl`, to say whether it works. Resolves to what it saw. */
export const testProxyConnection = (proxyUrl: string) =>
    rpc<string>('test_proxy_connection', { proxyUrl })

/** A POST to the Filen gateway, which has no CORS headers, with the auth and checksum it wants. */
export const filenGateway = (endpoint: string, body: Record<string, unknown>) =>
    rpc<{ status: number; body: string }>('filen_gateway', { endpoint, body })

/**
 * rclone's `mount/mount` body, as `buildMountRequest` (lib/rclone/mount.ts) builds it: the source
 * with its options serialized in, the mount point as rclone wants it, the option groups keyed by
 * rclone's Go field names. What the server sends, and what it saves for a mount at start.
 */
export interface MountRequest {
    fs: string
    mountPoint: string
    mountType?: string
    mountOpt?: string
    vfsOpt?: string
    _config?: string
    _filter?: string
}

/** Starts the mount: the server makes the mount point ready, sends the request, and notifies a failure. Resolves to the mount point (on Windows, `*` becomes the letter rclone picked). */
export const mountStart = (request: MountRequest) => rpc<string>('mount_start', { request })
