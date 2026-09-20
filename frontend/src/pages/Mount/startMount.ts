// Starting a mount: the destination checks, the option rekeying rclone's `mount/mount` wants,
// and the call itself. A mount is no transfer, so it is not recorded; a failure is notified.

import pRetry from 'p-retry'
import { UserCancelledError, formatErrorMessage } from '@/lib/errors'
import { getFsInfo } from '@/lib/format'
import { dispatchNotification } from '@/lib/notifications'
import rclone, { currentHostOs, isHostWindows } from '@/lib/rclone/client'
import type { MountArgs } from '@/lib/rclone/preset'
import {
    mergeMetadataOptions,
    serializeOptions,
    toConfigParam,
    toFilterParam,
} from '@/lib/rclone/requests'
import type { FlagValue } from '@/lib/rclone/types'

const RE_BACKSLASH = /\\/g
const RE_DASH = /-/g
const RE_PATH_SEPARATOR = /[/\\]/
const RE_WINDOWS_DRIVE_LETTER = /^[a-zA-Z]:$/

const RETRY_OPTIONS = {
    retries: 3,
    shouldRetry: ({ error }: { error: unknown }) => !(error instanceof UserCancelledError),
}

// Wraps the mount flow so a failure emits the mount.failed webhook event. Rethrows for the
// caller's own handling.
export async function startMount(params: MountArgs) {
    try {
        return await startMountInner(params)
    } catch (error) {
        dispatchNotification('mount.failed', {
            title: 'Mount failed',
            body: `Failed to mount ${params.source}: ${formatErrorMessage(error, 'Unknown error')}`,
            data: {
                source: params.source,
                destination: params.destination,
                error: formatErrorMessage(error, String(error)),
            },
        })
        throw error
    }
}

async function startMountInner({ source, destination, options }: MountArgs) {
    // The mount happens where the daemon runs: the selected host's OS, not the page server's.
    const currentPlatform = currentHostOs()
    let needsVolumeName = currentPlatform === 'macos'

    if (
        currentPlatform === 'windows' &&
        destination !== '*' &&
        !RE_WINDOWS_DRIVE_LETTER.test(destination)
    ) {
        needsVolumeName = true
    }

    const mountOptions = { ...(options.mount || {}) }

    const hasVolumeName = 'volname' in mountOptions && mountOptions.volname
    if (!hasVolumeName && needsVolumeName) {
        const segments = source.split(RE_PATH_SEPARATOR).filter(Boolean)

        const sourcePath = segments.length === 1 ? segments[0].replace(/:/g, '') : segments.pop()

        mountOptions.volname = `${sourcePath}-${Math.random().toString(36).substring(2, 3).toUpperCase()}`
    }

    // `_filter` is the correct RC channel for mount filters (rclone's own RC docs say so), so we
    // send it as a proper param rather than smuggling it into the fs string. Note: current rclone
    // ignores it for mounts — mountRc has the filter on its ctx, but Mount() builds the VFS with
    // context.Background() and discards it (only the *global* filter, set via CLI --exclude, reaches
    // a mount). Rclone still parses this value, but it only affects the mount if upstream threads
    // that request context into the VFS.
    const merged = mergeMetadataOptions({
        config: options.config,
        filter: options.filter,
        metadata: options.metadata,
    })
    const configParam = toConfigParam(merged.config)
    const filterParam = toFilterParam(merged.filter)

    const vfsOptions = { ...(options.vfs || {}) }

    // mountOpt/vfsOpt take JSON keyed by Go field names, so rekey the flag-name groups
    // ("vfs_cache_mode" → "CacheMode") via the options/info registry before sending. Unknown
    // keys pass through untouched — rclone ignores unrecognized fields.
    const toStructOptions = (
        flags: Record<string, FlagValue>,
        infos: { Name: string; FieldName: string; Type: string }[] | undefined
    ) => {
        const optionsByName = new Map((infos || []).map((info) => [info.Name, info]))
        return JSON.stringify(
            Object.fromEntries(
                Object.entries(flags).map(([key, value]) => {
                    const normalized = (key.startsWith('--') ? key.slice(2) : key).replace(
                        RE_DASH,
                        '_'
                    )
                    const option = optionsByName.get(normalized)
                    return [
                        option?.FieldName || key,
                        option?.Type === 'stringArray' && !Array.isArray(value) && value !== null
                            ? [String(value)]
                            : value,
                    ]
                })
            )
        )
    }

    let structOptions: { mountOpt?: string; vfsOpt?: string } = {}
    if (Object.keys(mountOptions).length > 0 || Object.keys(vfsOptions).length > 0) {
        const optionsInfo = await pRetry(
            async () =>
                await rclone('/options/info', { params: { query: { blocks: 'mount,vfs' } } }),
            RETRY_OPTIONS
        )
        structOptions = {
            ...(Object.keys(mountOptions).length > 0
                ? { mountOpt: toStructOptions(mountOptions, optionsInfo?.mount) }
                : {}),
            ...(Object.keys(vfsOptions).length > 0
                ? { vfsOpt: toStructOptions(vfsOptions, optionsInfo?.vfs) }
                : {}),
        }
    }

    const { fullDirPath: srcFullDirPath, remoteName: srcRemoteName } = getFsInfo(source)

    const srcOptions =
        options.remotes && srcRemoteName && srcRemoteName in options.remotes
            ? options.remotes[srcRemoteName]
            : undefined

    if (destination === '*' && currentPlatform === 'windows') {
        const response = await pRetry(
            async () =>
                await rclone('/mount/mount', {
                    params: {
                        query: {
                            fs: serializeOptions(srcFullDirPath, {
                                remote: srcOptions,
                            }),
                            mountPoint: '*',
                            // No mountType — Windows uses rclone's default resolution (cmount/WinFsp)
                            ...structOptions,
                            ...(configParam ? { _config: configParam } : {}),
                            ...(filterParam ? { _filter: filterParam } : {}),
                        },
                    },
                }),
            RETRY_OPTIONS
        )
        return response?.mountPoint
    }

    const {
        root: dstRoot,
        filePath: dstFilePath,
        fullDirPath: dstFullDirPath,
    } = getFsInfo(destination)

    const dstFs = dstRoot
    const dstFilePathNormalized = dstFilePath.replace(RE_BACKSLASH, '/')

    let directoryExists: boolean | undefined

    try {
        const r = await pRetry(
            async () =>
                await rclone('/operations/stat', {
                    params: {
                        query: {
                            fs: dstFs,
                            remote: dstFilePathNormalized,
                        },
                    },
                }),
            RETRY_OPTIONS
        )
        if (!r || !r.item) {
            directoryExists = false
        } else {
            if (!r.item.IsDir) {
                throw new Error('The selected directory is not a directory')
            }
            directoryExists = true
        }
    } catch (err) {
        console.error('[Mount] Error checking if directory exists:', err)
    }

    // The mount happens where the daemon runs: the selected host's OS, not the page server's.
    const isPlatformWindows = isHostWindows()

    if (directoryExists) {
        let isEmpty = false
        try {
            const { list } = await pRetry(
                async () =>
                    await rclone('/operations/list', {
                        params: {
                            query: {
                                fs: dstRoot,
                                remote: dstFilePath,
                            },
                        },
                    }),
                RETRY_OPTIONS
            )
            isEmpty = !list || list.length === 0
        } catch (err) {
            console.error('[Mount] Error checking if directory is empty:', err)
        }

        if (!isEmpty) {
            throw new Error('The selected directory must be empty to mount a remote.')
        }

        if (isPlatformWindows) {
            try {
                await pRetry(
                    async () =>
                        await rclone('/operations/rmdir', {
                            params: {
                                query: {
                                    fs: dstRoot,
                                    remote: dstFilePath,
                                },
                            },
                        }),
                    RETRY_OPTIONS
                )
            } catch (err) {
                console.error('[Mount] Error removing directory:', err)
            }
        }
    } else if (!isPlatformWindows) {
        try {
            await pRetry(
                async () =>
                    await rclone('/operations/mkdir', {
                        params: {
                            query: {
                                fs: dstRoot,
                                remote: dstFilePath,
                            },
                        },
                    }),
                RETRY_OPTIONS
            )
        } catch (error) {
            console.error('[Mount] Error creating directory:', error)
            throw new Error('Failed to create mount directory. Try creating it manually first.')
        }
    }

    await pRetry(
        async () =>
            await rclone('/mount/mount', {
                params: {
                    query: {
                        fs: serializeOptions(srcFullDirPath, {
                            remote: srcOptions,
                        }),
                        mountPoint: (() => {
                            // The root carries its own slash (`:local:/…`), so the backend's
                            // name comes off and nothing goes on.
                            if (!isHostWindows()) {
                                return dstFullDirPath.replace(':local:', '')
                            }
                            const mp = dstFullDirPath
                                .replace(':local:', '')
                                .replace(RE_BACKSLASH, '/')
                                .replace(/\/+/g, '/')
                            if (/^[a-zA-Z]:\/$/.test(mp)) {
                                return mp.slice(0, -1)
                            }
                            return mp
                        })(),
                        ...(currentPlatform === 'macos' ? { mountType: 'nfsmount' } : {}),
                        ...structOptions,
                        ...(configParam ? { _config: configParam } : {}),
                        ...(filterParam ? { _filter: filterParam } : {}),
                    },
                },
            }),
        RETRY_OPTIONS
    )
}

