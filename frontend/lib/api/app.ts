// The app's process and platform integration: version, quit/relaunch, self-update, and the
// lifecycle (the rclone daemon the server manages). Starting at boot is the operator's job,
// through whatever supervisor runs the server.

import { rpc, stream } from './rpc'

export interface AppInfo {
    version: string
    mode: 'desktop' | 'server'
    os: string
    arch: string
    logDir: string | null
    logFile: string | null
}

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

export const info = () => rpc<AppInfo>('app_info')
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
    defaultConfigPath?: string
    configFiles?: unknown[]
    activeConfigId?: string | null
    proxy?: { url: string; ignoredHosts: string[] } | undefined
    syncConfigToSystem?: boolean
    syncConfigLinkTarget?: string | null
}

export interface Status {
    mode: 'desktop' | 'server'
    version: string
    uptimeSeconds: number
    dirs: { data: string }
    authRequired: boolean
    managedDaemon: boolean
    lifecycle: import('./events').LifecyclePhase | null
    startup: 'initializing' | 'updating' | 'updated' | 'initialized' | 'error' | 'fatal' | null
    daemon: { url: string } | null
    tunnel: { url: string; user?: string; pass?: string } | null
}

export async function status(): Promise<Status> {
    const response = await fetch('/api/status', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`status: HTTP ${response.status}`)
    return (await response.json()) as Status
}

export const restartRclone = (overrides?: RestartOverrides) =>
    rpc<null>('rclone_restart', { overrides: overrides ?? null })
export const stopRclone = () => rpc<null>('rclone_stop')
export const rclonePassword = (configId: string, pass: string) =>
    rpc<null>('rclone_password', { configId, pass })

// --- downloads ----------------------------------------------------------------------

export const downloadLink = (fs: string, remote: string) =>
    rpc<string>('download_link', { fs, remote })

// --- third-party fetches the server makes on the page's behalf ---------------------------

export const rcloneLatestVersion = () => rpc<string>('rclone_latest_version')
export const rcloneReleases = (minVersion: string, limit: number) =>
    rpc<{ version: string; publishedAt: string }[]>('rclone_releases', { minVersion, limit })
export const winfspDownload = () => rpc<string>('winfsp_download')
