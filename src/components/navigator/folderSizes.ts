import { useEffect, useMemo, useState } from 'react'
import type { Browse } from '../../../lib/core/types'
import { usePref } from '../../../lib/prefs'
import { isShown, useHiddenFiles } from './hiddenFiles'
import { type JobState, useJob } from './jobs'

export function useFolderSizes() {
    return usePref('folderSizes')
}

export interface Listed {
    folder: string
    paths: string[]
    fetchedAt: number
}

type Listing = Pick<JobState<Browse.Row>, 'phase' | 'items' | 'fetchedAt'>

export function listedFolders(
    listing: Listing,
    folder: string | null,
    hidden = false
): Listed | null {
    if (!folder || listing.phase !== 'done' || listing.fetchedAt === undefined) return null
    const paths = listing.items
        .filter((row) => row.isDir && isShown(row.name, hidden))
        .map((row) => row.path)
    if (paths.length === 0) return null
    return { folder, paths, fetchedAt: listing.fetchedAt }
}

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

export function measured(sizes: readonly Browse.FolderSize[]): ReadonlyMap<string, number> {
    const map = new Map<string, number>()
    for (const size of sizes) if (!size.partial && size.path) map.set(size.path, size.bytes)
    return map
}

export function useFolderSizeJob(
    listing: Listing,
    folder: string | null
): ReadonlyMap<string, number> {
    const [on] = useFolderSizes()
    const [hidden] = useHiddenFiles()
    const { phase, items, fetchedAt } = listing
    const done = useMemo(
        () => listedFolders({ phase, items, fetchedAt }, folder, hidden),
        [phase, items, fetchedAt, folder, hidden]
    )
    const [kept, setKept] = useState<Listed | null>(null)
    useEffect(() => {
        if (phase !== 'running' || !folder) setKept(done)
    }, [phase, folder, done])
    const job = useJob<Browse.FolderSize>('sizes', sizesAsk(on, phase, done, kept, folder))
    return useMemo(() => measured(job.items), [job.items])
}
