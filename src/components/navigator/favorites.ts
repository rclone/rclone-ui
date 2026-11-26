import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { favorites as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

export interface Favorite {
    path: string
    added: number
}

const listKey = coreKey('favorites', 'List')

type Stored = Awaited<ReturnType<typeof api.List>>

export function useFavorites(): Favorite[] {
    const { data } = useQuery({ queryKey: listKey, queryFn: () => api.List() })
    return useMemo(() => (data ?? []).map((f) => ({ path: f.path, added: f.addedAt })), [data])
}

export function useToggleFavorite(): (path: string, on: boolean) => Promise<void> {
    const queryClient = useQueryClient()
    return useCallback(
        async (path: string, on: boolean) => {
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
