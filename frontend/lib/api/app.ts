// The app's process and platform integration: version, quit/relaunch, self-update, and the
// lifecycle (the rclone daemon the server manages). Starting at boot is the operator's job,
// through whatever supervisor runs the server.

import { rpc, stream } from './rpc'


export interface UpdateInfo {
    version: string
    currentVersion: string
    body: string | null
    date: string | null
}

export interface UpdateProgress {
    event: 'Started' | 'Progress' | 'Finished'
    data?: { contentLength?: number | null; chunkLength?: number }
}

export const quit = () => rpc<null>('app_quit')
export const relaunch = () => rpc<null>('app_relaunch')
export const updateCheck = () => rpc<UpdateInfo | null>('app_update_check')
export async function updateInstall(
    onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
    const handle = await stream<null, UpdateProgress>('app_update_install', {}, (event) =>
        onProgress?.(event)
    )
    handle.unsubscribe()
}
/** The dialog is one at a time across pages, per remote. */
export const claimReconnectDialog = (remote: string) =>
    rpc<boolean>('claim_reconnect_dialog', { remote })
export const releaseReconnectDialog = (remote: string) =>
    rpc<null>('release_reconnect_dialog', { remote })

// --- lifecycle ---------------------------------------------------------------------------

export interface RestartOverrides {
    rclonePath?: string
    proxy?: { url: string; ignoredHosts: string[] } | undefined
    limits?: { bwLimit: string; tpsLimit: number; tpsLimitBurst: number } | undefined
}

export interface Status {
    version: string
    uptimeSeconds: number
    dirs: { data: string }
    managedDaemon: boolean
    lifecycle: import('./events').LifecyclePhase | null
    daemon: { url: string } | null
}

export async function status(): Promise<Status> {
    const response = await fetch('/api/status', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`status: HTTP ${response.status}`)
    return (await response.json()) as Status
}

export const restartRclone = (overrides?: RestartOverrides) =>
    rpc<null>('rclone_restart', { overrides: overrides ?? null })
export const stopRclone = () => rpc<null>('rclone_stop')

// --- downloads ----------------------------------------------------------------------

export const downloadLink = (fs: string, remote: string) =>
    rpc<string>('download_link', { fs, remote })

// --- third-party fetches the server makes on the page's behalf ---------------------------

export const rcloneLatestVersion = () => rpc<string>('rclone_latest_version')
export const rcloneReleases = (minVersion: string, limit: number) =>
    rpc<{ version: string; publishedAt: string }[]>('rclone_releases', { minVersion, limit })

// --- mounting -----------------------------------------------------------------------------

/** Whether the server's machine can mount; when it cannot, why, and where setting it up is explained. */
export interface MountSupport {
    supported: boolean
    reason?: string
    docs?: string
}

export const mountSupport = () => rpc<MountSupport>('mount_support')
