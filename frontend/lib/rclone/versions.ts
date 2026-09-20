import rcloneClient from './client'
import { RCLONE_RELEASES_SHOWN } from './constants'
import { rcloneInstall, rcloneReleases } from '../api/app'
import { on as onAppEvent } from '../api/events'
import { ask } from '../api/dialog'
import { transfersList } from '../api/transfers'
import { isMoving } from '../transfers/live'

export interface AvailableRelease {
    version: string
    publishedAt: string
}

export interface DownloadProgress {
    version: string
    downloaded: number
    total: number | null
}

/**
 * The stable rclone releases this server can run (best-effort: the list comes from GitHub). The
 * default is this product's page size; the settings raise it when the user asks for more.
 */
export async function fetchAvailableVersions(
    limit: number = RCLONE_RELEASES_SHOWN
): Promise<AvailableRelease[]> {
    return await rcloneReleases(limit)
}

/**
 * Installs a version over the server's own rclone, forwarding its download progress. The server
 * restarts the daemon on it.
 */
export async function installVersion(
    version: string,
    onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
    const unlisten = onAppEvent('rclone.download-progress', (progress) => {
        if (progress.version === version) {
            onProgress?.(progress)
        }
    })
    try {
        return await rcloneInstall(version)
    } finally {
        unlisten()
    }
}

/**
 * True if switching rclone would interrupt something. The switch restarts the daemon, so that is
 * what is asked about: its running transfers from the record (known from the moment they start),
 * a scheduled run among them — those are on this daemon too, and the restart would take them
 * with it — then its files in flight for what nothing recorded (a job put on the daemon by
 * something else), then its mounts.
 */
export async function isRcloneBusy(): Promise<boolean> {
    try {
        const entries = await transfersList()
        if (entries.some((entry) => entry.state === 'running')) return true
    } catch (error) {
        console.warn('[isRcloneBusy] transfers_list failed', error)
    }
    if (await isMoving()) return true
    try {
        const mounts = (await rcloneClient('/mount/listmounts')) as { mountPoints?: unknown[] }
        if ((mounts?.mountPoints?.length ?? 0) > 0) {
            return true
        }
    } catch (error) {
        console.warn('[isRcloneBusy] mount/listmounts failed', error)
    }
    return false
}

/** Changing the binary restarts rclone: asks first when that would interrupt something. */
export async function confirmIfBusy(): Promise<boolean> {
    if (!(await isRcloneBusy())) return true
    return await ask(
        'Transfers or mounts are in progress and will be interrupted by switching rclone. Continue?',
        {
            title: 'Rclone is busy',
            kind: 'warning',
            okLabel: 'Switch anyway',
            cancelLabel: 'Cancel',
        }
    )
}
