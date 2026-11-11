// Folder sizes. The size of a local folder is the size of its inode, not of its contents. So a
// panel on a local folder asks the core to measure the folders it shows (browse.Sizes). The core
// walks each folder, which takes a while under a large folder such as the home folder. The user
// can turn this off in the panel settings (the cog in `PlacesMenu`), which saves a preference.
// Then nothing is measured, a count in progress is cancelled, and folders show no size. The
// pickers use the same file panels, so they follow the same setting.

import { useEffect, useMemo, useState } from 'react'
import type { Browse } from '../../../lib/core/types'
import { usePref } from '../../../lib/prefs'
import { type JobState, useJob } from './jobs'

/** Whether the panels measure the folders they show (on by default), and its setter. */
export function useFolderSizes() {
    return usePref('folderSizes')
}

/** The folders to measure from a finished listing of a local folder, by the paths of their rows. */
export interface Listed {
    folder: string
    paths: string[]
    fetchedAt: number
}

type Listing = Pick<JobState<Browse.Row>, 'phase' | 'items' | 'fetchedAt'>

/**
 * The folders shown by a finished listing of `folder`, and the time rclone listed them.
 * Dot-folders are hidden, so they are never measured. A listing served from the core's cache
 * keeps its existing sizes, and a new fetch measures them again.
 */
export function listedFolders(listing: Listing, folder: string | null): Listed | null {
    if (!folder || listing.phase !== 'done' || listing.fetchedAt === undefined) return null
    const paths = listing.items
        .filter((row) => row.isDir && !row.name.startsWith('.'))
        .map((row) => row.path)
    if (paths.length === 0) return null
    return { folder, paths, fetchedAt: listing.fetchedAt }
}

/**
 * The arguments for the sizes job, or `null` when there is nothing to measure (including when
 * sizes are off). While the same folder is listed again (after a change or a refresh), the panel
 * keeps the sizes it had (`kept`). A listing that comes back unchanged keeps the same job, and a
 * new listing (with a different `fetchedAt`) measures again.
 */
export function sizesAsk(
    on: boolean,
    phase: Listing['phase'],
    done: Listed | null,
    kept: Listed | null,
    folder: string | null
): { paths: string[]; fetchedAt: number } | null {
    if (!on) return null
    const asked =
        phase === 'done'
            ? done
            : phase === 'running' && kept && kept.folder === folder
              ? kept
              : null
    return asked ? { paths: asked.paths, fetchedAt: asked.fetchedAt } : null
}

/** The sizes of the measured folders, by path. A folder whose count was cut short has no size. */
export function measured(sizes: readonly Browse.FolderSize[]): ReadonlyMap<string, number> {
    const map = new Map<string, number>()
    for (const size of sizes) if (!size.partial && size.path) map.set(size.path, size.bytes)
    return map
}

/**
 * The sizes of the folders a panel shows. `folder` is the local folder that the listing belongs
 * to. It is `null` on a remote, or while the listing still holds another folder's rows. Leaving
 * the folder or turning sizes off cancels the count.
 */
export function useFolderSizeJob(
    listing: Listing,
    folder: string | null
): ReadonlyMap<string, number> {
    const [on] = useFolderSizes()
    const { phase, items, fetchedAt } = listing
    const done = useMemo(
        () => listedFolders({ phase, items, fetchedAt }, folder),
        [phase, items, fetchedAt, folder]
    )
    const [kept, setKept] = useState<Listed | null>(null)
    useEffect(() => {
        if (phase !== 'running' || !folder) setKept(done)
    }, [phase, folder, done])
    const job = useJob<Browse.FolderSize>('sizes', sizesAsk(on, phase, done, kept, folder))
    return useMemo(() => measured(job.items), [job.items])
}
