import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { favorites as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

// The favorite places, which are paths that the file browser and the pickers offer first. The
// favorites.changed event keeps them up to date.

export interface Favorite {
    /** An rclone path: `gdrive:Photos` or a local path. */
    path: string
    /** In milliseconds since the epoch. */
    added: number
}

const listKey = coreKey('favorites', 'List')

type Stored = Awaited<ReturnType<typeof api.List>>

/** All favorites, oldest first. */
export function useFavorites(): Favorite[] {
    const { data } = useQuery({ queryKey: listKey, queryFn: () => api.List() })
    return useMemo(() => (data ?? []).map((f) => ({ path: f.path, added: f.addedAt })), [data])
}

/**
 * Returns a function that stars or unstars a path. The star changes at once, before the core
 * answers. If the core refuses the change, the star goes back and the function rejects, so the
 * caller can report the error.
 */
export function useToggleFavorite(): (path: string, on: boolean) => Promise<void> {
    const queryClient = useQueryClient()
    return useCallback(
        async (path: string, on: boolean) => {
            // A read in flight would bring back the list from before this change.
            await queryClient.cancelQueries({ queryKey: listKey })
            const before = queryClient.getQueryData<Stored>(listKey)
            queryClient.setQueryData<Stored>(listKey, (old) => {
                const others = (old ?? []).filter((f) => f.path !== path)
                return on ? [...others, { path, addedAt: Date.now() } as Stored[number]] : others
            })
            try {
                await (on ? api.Add(path) : api.Remove(path))
            } catch (error) {
                queryClient.setQueryData(listKey, before)
                throw error
            }
        },
        [queryClient]
    )
}
