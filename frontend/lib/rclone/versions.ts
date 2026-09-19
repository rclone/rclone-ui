import { useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import { restartActiveRclone } from './cli'
import rcloneClient from './client'
import { MIN_RCLONE_VERSION, RCLONE_RELEASES_SHOWN } from './constants'
import { rcloneReleases } from '../api/app'
import { on as onAppEvent } from '../api/events'
import { ask } from '../api/dialog'
import { rpc } from '../api/rpc'
import { transfersList } from '../api/transfers'
import { isMoving } from '../transfers/live'

export interface DownloadedVersion {
    version: string
    path: string
    sizeBytes: number
}

export interface AvailableRelease {
    version: string
    publishedAt: string
}

export interface PathStatus {
    enabled: boolean
    target: string | null
    warning: string | null
}

export interface DownloadProgress {
    version: string
    downloaded: number
    total: number | null
}

export async function listDownloadedVersions(): Promise<DownloadedVersion[]> {
    return await rpc<DownloadedVersion[]>('list_downloaded_rclone_versions')
}

/**
 * Fetches stable rclone releases at or above the minimum supported version (best-effort). The
 * default is this product's page size; the settings raise it when the user asks for more.
 */
export async function fetchAvailableVersions(
    limit: number = RCLONE_RELEASES_SHOWN
): Promise<AvailableRelease[]> {
    return await rcloneReleases(MIN_RCLONE_VERSION, limit)
}

/**
 * Downloads a version into the managed library, forwarding progress events for the given version.
 * Returns the absolute path of the installed binary.
 */
export async function downloadVersion(
    version: string,
    onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
    const unlisten = onAppEvent('rclone.download-progress', (progress) => {
        if (progress.version === version) {
            onProgress?.(progress)
        }
    })
    try {
        const proxyUrl = useHostStore.getState().proxy?.url ?? null
        return await rpc<string>('download_rclone_version', { version, proxyUrl })
    } finally {
        unlisten()
    }
}

export async function deleteVersion(version: string): Promise<void> {
    const activePath = usePersistedStore.getState().rclonePath ?? null
    await rpc('delete_rclone_version', { version, activePath })
}

/**
 * True if switching rclone would interrupt something. The switch restarts the daemon, so that is
 * what is asked about: its running transfers from the record (known from the moment they start),
 * a scheduled run among them — those are on this daemon too, and the restart would take them
 * with it — then its files in flight for what nothing recorded (a job put on the daemon by
 * something else), then its mounts.
 */
async function isRcloneBusy(): Promise<boolean> {
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

/**
 * Points the app at `path` and restarts the daemon on it. Confirms first when transfers/mounts
 * are active. Returns false if the user cancelled.
 */
export async function activateRclonePath(path: string): Promise<boolean> {
    if (await isRcloneBusy()) {
        const proceed = await ask(
            'Transfers or mounts are in progress and will be interrupted by switching rclone. Continue?',
            {
                title: 'Rclone is busy',
                kind: 'warning',
                okLabel: 'Switch anyway',
                cancelLabel: 'Cancel',
            }
        )
        if (!proceed) {
            return false
        }
    }

    usePersistedStore.getState().setRclonePath(path)

    try {
        await rpc('update_path_pointer', { targetPath: path })
    } catch (error) {
        console.warn('[activateRclonePath] update_path_pointer failed', error)
    }
    await restartActiveRclone()
    return true
}


export async function getPathIntegration(): Promise<PathStatus> {
    return await rpc<PathStatus>('get_rclone_path_integration')
}

export async function setPathIntegration(enable: boolean, targetPath: string): Promise<PathStatus> {
    return await rpc<PathStatus>('set_rclone_path_integration', {
        enable,
        targetPath,
    })
}

