import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { RcloneFeatures, RcloneFsInfo } from '../types/rclone'
import { UserCancelledError } from './errors'
import { sortByName } from './flags'
import rclone from './rclone/client'
import { SERVE_TYPES } from './rclone/constants'

// Wall-clock tick for values derived from "now" (relative timestamps, next cron occurrences).
// Memoizing such values without a time dep freezes them at their last dep change. Pass null to
// pause (e.g. while a drawer is closed); re-arming refreshes immediately.
export function useNow(intervalMs: number | null = 30_000): number {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (intervalMs === null) {
            return
        }
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])

    return now
}

// Shared query options for a remote's `/config/get`. No default staleTime: most consumers rely on
// staleTime-0 refetch-on-mount for cross-window freshness (each webview has its own QueryClient);
// the handful that want caching spread `staleTime` per-site.
export function remoteConfigQueryOptions(remote: string | undefined | null) {
    return {
        queryKey: ['remote', remote, 'config'] as const,
        queryFn: () => rclone('/config/get', { params: { query: { name: remote! } } }),
        enabled: !!remote && remote !== 'UI_LOCAL_FS' && remote !== 'UI_FAVORITES',
    }
}

export function useRemoteConfig(remote: string | undefined | null) {
    return useQuery(remoteConfigQueryOptions(remote))
}

// Shared query options for a remote's `operations/fsinfo` — the authoritative, per-remote backend
// capability set (correct even for wrapping backends like crypt/alias/union, which the old static
// type lists could not express). fsinfo instantiates/connects the remote, so it's cached hard:
// capabilities are ~immutable per config and only change on a remote edit (explicit invalidation)
// or an rclone upgrade (self-heals on the 24h staleTime / next cold launch). retry: 1 overrides the
// app-wide 3-retry default so an unreachable remote costs one attempt, then error-caches.
export function fsInfoQueryOptions(remote: string | undefined | null) {
    return {
        queryKey: ['remote', remote, 'fsinfo'] as const,
        queryFn: () => rclone('/operations/fsinfo', { params: { query: { fs: `${remote}:` } } }),
        enabled: !!remote && remote !== 'UI_LOCAL_FS' && remote !== 'UI_FAVORITES',
        staleTime: 1000 * 60 * 60 * 24,
        // Cap retries low (dead remotes shouldn't retry 3× like the default) but keep the default's
        // UserCancelledError guard: a plain `retry: 1` would override it, and since fsinfo connects
        // to the remote, retrying a dismissed reconnect prompt re-prompts the user (client.ts).
        retry: (failureCount: number, error: unknown) =>
            !(error instanceof UserCancelledError) && failureCount < 1,
    }
}

export function useFsInfo(remote: string | undefined | null) {
    return useQuery(fsInfoQueryOptions(remote))
}

// undefined while loading/errored → false. Callers that need an optimistic default (e.g. create
// folder, which historically assumed "supported" until proven otherwise) handle that explicitly.
export function hasFeature(
    fsInfo: RcloneFsInfo | undefined,
    feature: keyof RcloneFeatures
): boolean {
    return !!fsInfo?.Features?.[feature]
}

export function useFlags() {
    const allFlagsQuery = useQuery({
        queryKey: ['options', 'all'],
        queryFn: async () => await rclone('/options/info'),
    })

    const globalFlagsQuery = useQuery({
        queryKey: ['options', 'global'],
        queryFn: async () => await rclone('/options/get'),
    })

    const globalFlags = globalFlagsQuery.data
    const allFlags = allFlagsQuery.data

    const filterFlags = allFlags?.filter
        ?.filter((flag) => !flag.Groups?.includes('Metadata'))
        .sort(sortByName)

    const configFlags = allFlags?.main
        ?.filter(
            (flag) =>
                flag.Groups?.includes('Performance') ||
                flag.Groups?.includes('Listing') ||
                flag.Groups?.includes('Networking') ||
                flag.Groups?.includes('Check') ||
                flag.Name === 'use_server_modtime'
        )
        .sort(sortByName)

    const mountFlags = allFlags?.mount
        ?.filter((flag) => !flag.Groups?.includes('Metadata'))
        .sort(sortByName)

    const vfsFlags = allFlags?.vfs
        ?.filter((flag) => !flag.Groups?.includes('Metadata'))
        .sort(sortByName)

    const copyFlags = allFlags?.main
        ?.filter((flag) => flag.Groups?.includes('Copy'))
        .sort(sortByName)

    const syncFlags = allFlags?.main
        ?.filter((flag) => flag.Groups?.includes('Copy') || flag.Groups?.includes('Sync'))
        .sort(sortByName)

    const serveFlags = SERVE_TYPES.reduce(
        (acc, type) => {
            acc[type] = (allFlags?.[type] || [])
                .map((flag: any) => ({
                    ...flag,
                    FieldName: flag.Name,
                    DefaultStr:
                        flag.Name === 'addr'
                            ? flag.DefaultStr.replace('[', '').replace(']', '')
                            : flag.DefaultStr,
                }))
                .sort((a: any, b: any) => a.Name.localeCompare(b.Name))
            return acc
        },
        {} as Record<(typeof SERVE_TYPES)[number], any[]>
    )

    return {
        allFlags,
        globalFlags,
        filterFlags,
        configFlags,
        mountFlags,
        vfsFlags,
        copyFlags,
        syncFlags,
        serveFlags,
    }
}
