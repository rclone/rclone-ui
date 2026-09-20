import pRetry from 'p-retry'
import { ask } from '@/dialog'
import { UserCancelledError } from '@/lib/errors'
import { getFsInfo } from '@/lib/format'
import { openUrl } from '@/navigate'
import { type MountRequest, mountSupport } from '@/server/app'
import rclone, { currentHostOs, isHostWindows } from './client'
import type { MountArgs } from './preset'
import { mergeMetadataOptions, serializeOptions, toConfigParam, toFilterParam } from './requests'
import type { FlagValue } from './types'

// Whether the machine can mount is the server's to say (WinFsp on Windows, /dev/fuse on Linux),
// and it looks every time it is asked: either can turn up while the server runs. Setting it up
// is the operator's; the page only says what is missing and where to read on.
export function mountSupportQueryOptions() {
    return {
        queryKey: ['mount', 'support'] as const,
        queryFn: mountSupport,
        staleTime: 0,
    }
}

/** After a mount failed: when the machine cannot mount, says why. Returns whether it did. */
export async function explainMountFailure(): Promise<boolean> {
    const support = await mountSupport().catch(() => null)
    if (!support || support.supported) return false
    const wantsDocs = await ask(
        `${support.reason}\n\nSet it up on the server, then start the mount again.`,
        {
            title: 'This server cannot mount',
            kind: 'warning',
            okLabel: currentHostOs() === 'windows' ? 'WinFsp on GitHub' : 'Open the docs',
            cancelLabel: 'Close',
        }
    )
    if (wantsDocs && support.docs) await openUrl(support.docs)
    return true
}

export class AutomountSourceError extends Error {}

export async function probeMountSource(source: string) {
    const { root, filePath } = getFsInfo(source)

    if (!filePath) {
        await rclone('/operations/list', { params: { query: { fs: root, remote: '' } } })
        return
    }

    const r = await rclone('/operations/stat', {
        params: { query: { fs: root, remote: filePath } },
    })
    if (!r || !r.item) {
        throw new AutomountSourceError(
            `"${filePath}" was not found on ${root}. Fix the Remote Path in the remote's Auto Mount settings`
        )
    }
    if (!r.item.IsDir) {
        throw new AutomountSourceError(
            `"${filePath}" on ${root} is a file, not a folder. Fix the Remote Path in the remote's Auto Mount settings`
        )
    }
}

// --- the request ------------------------------------------------------------------------------

const RE_BACKSLASH = /\\/g
const RE_DASH = /-/g
const RE_PATH_SEPARATOR = /[/\\]/
const RE_WINDOWS_DRIVE_LETTER = /^[a-zA-Z]:$/

const RETRY_OPTIONS = {
    retries: 3,
    shouldRetry: ({ error }: { error: unknown }) => !(error instanceof UserCancelledError),
}

// mountOpt/vfsOpt take JSON keyed by Go field names, so the flag-name groups are rekeyed
// ("vfs_cache_mode" → "CacheMode") via the options/info registry before sending. Unknown keys
// pass through untouched — rclone ignores unrecognized fields.
function toStructOptions(
    flags: Record<string, FlagValue>,
    infos: { Name: string; FieldName: string; Type: string }[] | undefined
) {
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

// The root carries its own slash (`:local:/…`), so the backend's name comes off and nothing
// goes on. The mount happens where the daemon runs: its OS decides, never the browser's.
function mountPointOf(destination: string): string {
    const { fullDirPath } = getFsInfo(destination)
    if (!isHostWindows()) {
        return fullDirPath.replace(':local:', '')
    }
    const mp = fullDirPath.replace(':local:', '').replace(RE_BACKSLASH, '/').replace(/\/+/g, '/')
    return /^[a-zA-Z]:\/$/.test(mp) ? mp.slice(0, -1) : mp
}

/**
 * Exactly rclone's `mount/mount` body for what the page asked: the server sends it as it is
 * (`mountStart`), and keeps it as it is for a mount at start. Needs the daemon: the option
 * names rclone wants are its to say (`options/info`).
 */
export async function buildMountRequest({
    source,
    destination,
    options,
}: MountArgs): Promise<MountRequest> {
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

    // Windows picks the drive itself for `*` (no mountType: rclone's default resolution,
    // cmount/WinFsp); macOS mounts over the system NFS client.
    const wildcard = destination === '*' && currentPlatform === 'windows'
    return {
        fs: serializeOptions(srcFullDirPath, { remote: srcOptions }),
        mountPoint: wildcard ? '*' : mountPointOf(destination),
        ...(!wildcard && currentPlatform === 'macos' ? { mountType: 'nfsmount' } : {}),
        ...structOptions,
        ...(configParam ? { _config: configParam } : {}),
        ...(filterParam ? { _filter: filterParam } : {}),
    }
}
