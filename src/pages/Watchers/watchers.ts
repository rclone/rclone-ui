import { useQuery } from '@tanstack/react-query'
import { watchers as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Watchers } from '../../../lib/core/types'

// The watchers, as the Watchers window uses them. A watcher keeps two folders the same with a
// bisync every minute (core/watchers). watchers.changed keeps the list fresh, so the writes here
// only call the core.

type Watcher = Watchers.Watcher

export function useWatchers() {
    return useQuery({ queryKey: coreKey('watchers', 'List'), queryFn: () => api.List() })
}

/** An empty id creates a watcher. */
export function saveWatcher(input: Watchers.Input): Promise<Watcher> {
    return api.Save(input)
}

export async function setWatcherPaused(id: string, paused: boolean): Promise<void> {
    await (paused ? api.Pause(id) : api.Resume(id))
}

export async function syncWatcherNow(id: string): Promise<void> {
    await api.SyncNow(id)
}

/** Merges a watcher's two folders again, as its first sync did. */
export async function resyncWatcher(id: string): Promise<void> {
    await api.Resync(id)
}

/** Deletes in the other folder too the files that were deleted in one, after bisync stopped. */
export async function forceWatcher(id: string): Promise<void> {
    await api.Force(id)
}

/** Deletes a watcher. Its two folders and their files stay as they are. */
export async function deleteWatcher(id: string): Promise<void> {
    await api.Delete(id)
}
