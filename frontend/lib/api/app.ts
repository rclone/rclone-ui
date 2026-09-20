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

export interface RestartOverrides {
    proxy?: { url: string; ignoredHosts: string[] } | undefined
    limits?: { bwLimit: string; tpsLimit: number; tpsLimitBurst: number } | undefined
}

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

export const restartRclone = (overrides?: RestartOverrides) =>
    rpc<null>('rclone_restart', { overrides: overrides ?? null })

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
