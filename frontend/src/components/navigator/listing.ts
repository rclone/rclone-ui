import { queryOptions } from '@tanstack/react-query'
import queryClient from '@/lib/query'
import { hostSeparator } from '@/lib/rclone/client'
import { localFs } from '@/lib/rclone/daemon-fs'
import { transfersList } from '@/server/transfers'
import { on } from '@/server/ws'
import {
    type ListingRemote,
    isListingUnder,
    listingKey,
    listingOf,
    parentListingOf,
} from './listingKey'
import type { Entry } from './types'
import { listPath, resolveFs } from './utils'

// The directory listings cache, in one place. A listing is one app-wide query per remote and
// directory: fresh for LISTING_FRESH_MS it is shown without asking rclone, whichever panel,
// drawer or visit wants it; kept LISTING_KEEP_MS after the last one looked; never persisted.
// Asked again before that only when something here says the folder changed: a panel's refresh
// (`useFileNavigation`), a change the Commander made (`invalidate*` below), or a transfer that
// ended (the subscription at the bottom).

/** How long a listing is trusted before a visit asks rclone again: the one number to change. */
export const LISTING_FRESH_MS = 5 * 60_000
/** How long an unwatched listing stays in memory. */
export const LISTING_KEEP_MS = 30 * 60_000
export const LISTING_FAILED = 'No access or folder does not exist'

const LIST_OPTIONS = { noModTime: false, noMimeType: true }

export function listingQueryOptions(remote: ListingRemote, dir: string) {
    const queryKey = listingKey(remote, dir)
    return queryOptions({
        queryKey,
        queryFn: ({ signal }) => fetchListing(remote, queryKey[2], signal),
        staleTime: LISTING_FRESH_MS,
        gcTime: LISTING_KEEP_MS,
        // One attempt (listPath's own trailing-slash second try aside): a folder that cannot be
        // listed says so at once.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // The daemon answers whether or not the browser believes it is online; a paused query
        // would show "No items" where an error is due.
        networkMode: 'always',
        meta: { persist: false },
    })
}

/** The rows of one directory, folders first: what the panels used to build for themselves. */
export async function fetchListing(
    remote: ListingRemote,
    dir: string,
    signal: AbortSignal
): Promise<Entry[]> {
    const rows =
        remote === 'UI_LOCAL_FS'
            ? await localEntries(dir, signal)
            : await remoteEntries(remote, dir, signal)
    return rows
        .filter((row) => !row.name.startsWith('.'))
        .sort((a, b) => {
            if (a.isDir && !b.isDir) return -1
            if (!a.isDir && b.isDir) return 1
            return a.name.localeCompare(b.name)
        })
}

async function remoteEntries(remote: string, cwd: string, signal: AbortSignal): Promise<Entry[]> {
    const listed = await listPath(remote, cwd || '', LIST_OPTIONS, signal)
    // The listing's paths are relative to the fs root, which is the remote and the slash the
    // location had (`remote:` or `remote:/`): put back in front, no more.
    const { fs: root } = resolveFs(remote, cwd)
    return listed.map((it) => {
        const rel = (it.Path || it.Name || '') as string
        const baseName = rel.split('/').pop() || ''
        const isDir = !!(it.IsDir || it.IsBucket)
        const full = `${root}${rel}`
        return {
            key: full,
            name: baseName,
            isDir,
            size: it.Size,
            modTime: it.ModTime,
            mimeType: it.MimeType,
            remote,
            fullPath: full,
        } as Entry
    })
}

async function localEntries(cwd: string, signal: AbortSignal): Promise<Entry[]> {
    const listed = await listPath('UI_LOCAL_FS', cwd, LIST_OPTIONS, signal)
    // rclone reports paths relative to the filesystem root ('/' or a drive); a folder's own
    // Size is its inode, not its contents, so folders wait for a size job.
    const { fs } = localFs(cwd)
    const rootPrefix = fs === ':local:/' ? '/' : fs.slice(':local:'.length)
    return listed.map((it) => {
        const rel = String(it.Path || it.Name || '')
        const name = String(it.Name || rel.split('/').pop() || '')
        const isDir = !!it.IsDir
        let fullPath = `${rootPrefix}${rel}`
        if (hostSeparator() === '\\') fullPath = fullPath.replace(/\//g, '\\')
        return {
            key: fullPath,
            name,
            isDir,
            size: !isDir && typeof it.Size === 'number' && it.Size >= 0 ? it.Size : undefined,
            modTime: it.ModTime,
            remote: 'UI_LOCAL_FS',
            fullPath,
        } as Entry
    })
}

/** One directory changed: a panel showing it refetches now, a cached copy on its next visit. */
export function invalidateListing(remote: ListingRemote, dir: string): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: listingKey(remote, dir), exact: true })
}

/** A folder and everything cached below it: a copy's destination, a deleted folder's old tree. */
export function invalidateFolder(fullPath: string): Promise<void> {
    const { remote, dir } = listingOf(fullPath)
    return queryClient.invalidateQueries({
        predicate: (query) => isListingUnder(query.queryKey, remote, dir),
    })
}

/** An entry changed: the folder holding it and, for a folder, whatever was cached under it. */
export async function invalidateEntry(fullPath: string, isDir: boolean): Promise<void> {
    const parent = parentListingOf(fullPath)
    await invalidateListing(parent.remote, parent.dir)
    if (isDir) await invalidateFolder(fullPath)
}

/** Rows patched in place (the folder sizes) without touching the listing's clock. */
export function patchListing(
    remote: ListingRemote,
    dir: string,
    update: (rows: Entry[]) => Entry[]
): void {
    const queryKey = listingKey(remote, dir)
    const state = queryClient.getQueryState<Entry[]>(queryKey)
    if (!state?.data) return
    queryClient.setQueryData<Entry[]>(queryKey, (rows) => (rows ? update(rows) : rows), {
        updatedAt: state.dataUpdatedAt,
    })
}

// A transfer that ended, started from any page, changed its destination; a move or a delete
// changed where its sources were too. Nothing to do while nothing is cached.
const MOVES_ITS_SOURCES = new Set(['move', 'delete', 'purge'])
on('transfers.changed', ({ id }) => {
    if (queryClient.getQueryCache().findAll({ queryKey: ['listing'] }).length === 0) return
    transfersList()
        .then((entries) => {
            const entry = entries.find((candidate) => candidate.id === id)
            if (!entry || entry.state === 'running') return
            if (entry.destination) void invalidateFolder(entry.destination)
            if (MOVES_ITS_SOURCES.has(entry.operation)) {
                for (const source of entry.sources) void invalidateEntry(source, true)
            }
        })
        .catch(() => {})
})
