// A folder's rows as the panels show them. The core owns the listing itself (the `list` job in
// jobs.ts, read through streams.ts). It keeps one cached listing per folder, shared by every
// panel, and lists again only after a refresh or a change. This file holds the display rules
// (dot-files hidden, folders first) and the change notices. When the page changes something
// through the fs actions, or a transfer ends, every panel that shows an affected folder asks the
// core for it again.

import { t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import { compareText } from '../../../lib/format'
import { onLive } from '../../../lib/live'
import {
    isListingUnder,
    type ListingRemote,
    listingKey,
    listingOf,
    parentListingOf,
} from './listingKey'
import type { Entry } from './types'

const LISTING_FAILED = t`No access or folder does not exist`

/** The maximum number of rows in a panel. Past it, the listing stops and the page says so. */
export const LIST_CAP = 50_000
export const SEARCH_CAP = 5_000

/**
 * The message for a failed listing: rclone's error, unless the core reports that the folder is
 * missing (`notFound`).
 */
export function listingError(error: string | undefined, notFound: boolean): string {
    return !error || notFound ? LISTING_FAILED : error
}

/**
 * Converts the core's rows into panel entries. A row's path is complete and written the same way
 * as the requested folder (with the host's separator for a local folder), so the entry uses it
 * as it is. The size of a local folder is its inode, not its contents, so local folders take
 * their size from the sizes job (`sizes`, by path). With `search`, matches are named by their
 * path below the searched folder.
 */
export function toEntries(
    rows: readonly Browse.Row[],
    remote: string | 'UI_LOCAL_FS',
    { sizes, search }: { sizes?: ReadonlyMap<string, number>; search?: boolean } = {}
): Entry[] {
    const local = remote === 'UI_LOCAL_FS'
    return rows
        .map((row) => {
            const isDir = row.isDir || row.isBucket
            // The backend reports -1 when it doesn't know the size. Treat that as no size, not as
            // a number to show or compare.
            let size: number | undefined = row.size >= 0 ? row.size : undefined
            if (local && isDir) size = sizes?.get(row.path)
            const entry: Entry = {
                key: row.path,
                name: row.name,
                isDir,
                size,
                modTime: row.modTime,
                remote,
                fullPath: row.path,
            }
            if (search) entry.displayName = row.below
            return entry
        })
        .filter((entry) => !entry.name.startsWith('.'))
        .sort((a, b) => {
            if (a.isDir && !b.isDir) return -1
            if (!a.isDir && b.isDir) return 1
            return compareText(a.name, b.name)
        })
}

/** The rows a panel last showed in full: the folder they belong to, and whether its listing ended. */
export interface Held<T> {
    at: string | null
    rows: T[]
    complete: boolean
}

/**
 * Whether the panel's folder is being listed again (after a refresh or a change in it). Until the
 * new rows are all in, the panel keeps showing the rows it held in full: the list stays at its
 * scroll position, and doesn't shrink to the first piece. A first listing that is still running
 * shows its pieces as they arrive.
 */
export function relisting<T>({
    at,
    held,
    current,
    phase,
}: {
    at: string | null
    held: Held<T>
    current: boolean
    phase: string
}): boolean {
    return current && at !== null && held.at === at && held.complete && phase === 'running'
}

type Changed = (panel: readonly ['listing', ListingRemote, string]) => boolean
const listeners = new Set<(changed: Changed) => void>()

/**
 * Calls `listener` with a test for the folders that changed. A panel lists its folder again when
 * the test matches it.
 */
export function onFolderChanged(listener: (changed: Changed) => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function announce(changed: Changed) {
    for (const listener of listeners) listener(changed)
}

/**
 * Marks a path as written, such as a transfer's destination. The panels on that folder, below it
 * and above it list again. The ones above do because the transfer may have created the folder.
 */
export function pathWritten(fullPath: string) {
    const { remote, dir } = listingOf(fullPath)
    const written = listingKey(remote, dir)
    announce(
        (panel) => isListingUnder(panel, remote, dir) || isListingUnder(written, panel[1], panel[2])
    )
}

/** Marks an entry as changed: its parent folder, and for a folder, everything below it. */
export function entryChanged(fullPath: string, isDir: boolean) {
    const parent = parentListingOf(fullPath)
    const parentKey = listingKey(parent.remote, parent.dir)
    const own = listingOf(fullPath)
    announce(
        (panel) =>
            (panel[1] === parentKey[1] && panel[2] === parentKey[2]) ||
            (isDir && isListingUnder(panel, own.remote, own.dir))
    )
}

// A transfer that ended, from any page, wrote its destination, and may have created the folders
// above it. A download's destination (from the Download page) is the entry it wrote. A move or a
// delete also changed the folders that held its sources. A bisync writes both ways, so its source
// (Path1) was written like its destination.
const MOVES_ITS_SOURCES = new Set(['move', 'delete', 'purge'])
const WRITES_ITS_SOURCES = new Set(['bisync'])

export function transferEnded(operation: string, sources: readonly string[], destination: string) {
    if (destination) pathWritten(destination)
    if (MOVES_ITS_SOURCES.has(operation)) {
        for (const source of sources) entryChanged(source, true)
    } else if (WRITES_ITS_SOURCES.has(operation)) {
        for (const source of sources) pathWritten(source)
    }
}

onLive('transfers.changed', (event) => {
    if (event.state === 'running' || event.state === 'queued') return
    transferEnded(event.operation, event.sources ?? [], event.destination ?? '')
})

// A mount that came up or went away shows something else at its mount point, so the panels on
// the mount point and on its parent list them again. A Windows drive (`X:`, or `*` before one is
// picked) isn't a folder that a panel lists.
const MOUNT_CHANGED = new Set(['running', 'restarting', 'failed', 'stopped'])
const DRIVE = /^(\*|[A-Za-z]:)$/

export function mountChanged({ state, mountPoint }: { state: string; mountPoint?: string }) {
    if (!mountPoint || DRIVE.test(mountPoint) || !MOUNT_CHANGED.has(state)) return
    entryChanged(mountPoint, true)
}

onLive('mounts.changed', mountChanged)

// A file action made by another window or by the core itself. The entry's parent folder changed,
// and for a folder, everything below it.
onLive('files.changed', (event) => {
    const dirs = event.dirs ?? []
    for (const name of event.names ?? []) entryChanged(name, dirs.includes(name))
})
