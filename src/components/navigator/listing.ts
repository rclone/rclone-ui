import { t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import { compareText } from '../../../lib/format'
import { onLive } from '../../../lib/live'
import { isShown } from './hiddenFiles'
import {
    isListingUnder,
    type ListingRemote,
    listingKey,
    listingOf,
    parentListingOf,
} from './listingKey'
import type { Entry } from './types'

const LISTING_FAILED = t`No access or folder does not exist`

export const LIST_CAP = 50_000
export const SEARCH_CAP = 5_000

export function listingError(error: string | undefined, notFound: boolean): string {
    return !error || notFound ? LISTING_FAILED : error
}

export function toEntries(
    rows: readonly Browse.Row[],
    remote: string | 'UI_LOCAL_FS',
    {
        sizes,
        search,
        hidden = false,
    }: { sizes?: ReadonlyMap<string, number>; search?: boolean; hidden?: boolean } = {}
): Entry[] {
    const local = remote === 'UI_LOCAL_FS'
    return rows
        .map((row) => {
            const isDir = row.isDir || row.isBucket
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
        .filter((entry) => isShown(entry.name, hidden))
        .sort((a, b) => {
            if (a.isDir && !b.isDir) return -1
            if (!a.isDir && b.isDir) return 1
            return compareText(a.name, b.name)
        })
}

export interface Held<T> {
    at: string | null
    rows: T[]
    complete: boolean
}

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

export function onFolderChanged(listener: (changed: Changed) => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function announce(changed: Changed) {
    for (const listener of listeners) listener(changed)
}

export function pathWritten(fullPath: string) {
    const { remote, dir } = listingOf(fullPath)
    const written = listingKey(remote, dir)
    announce(
        (panel) => isListingUnder(panel, remote, dir) || isListingUnder(written, panel[1], panel[2])
    )
}

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

const MOUNT_CHANGED = new Set(['running', 'restarting', 'failed', 'stopped'])
const DRIVE = /^(\*|[A-Za-z]:)$/

export function mountChanged({ state, mountPoint }: { state: string; mountPoint?: string }) {
    if (!mountPoint || DRIVE.test(mountPoint) || !MOUNT_CHANGED.has(state)) return
    entryChanged(mountPoint, true)
}

onLive('mounts.changed', mountChanged)

onLive('files.changed', (event) => {
    const dirs = event.dirs ?? []
    for (const name of event.names ?? []) entryChanged(name, dirs.includes(name))
})
