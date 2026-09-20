import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { on as onAppEvent } from '../api/ws'
import { transfersList } from '../api/transfers'
import { fetchLive, isLive } from './live'
import { toRows } from './rows'

/**
 * The transfers as rows, newest first: the Transfers page's list, and the Dashboard's few.
 *
 * The list is the server's record, not rclone's memory: a transfer is in it from the moment it
 * starts and stays after the daemon (or the server) restarts. The server says when it writes a
 * line; the slow refetch is the net under a dropped frame. rclone is
 * asked for one thing, the live numbers of what is running here, and only while something is.
 */
export function useTransferRows({
    limit,
    enabled = true,
}: { limit?: number; enabled?: boolean } = {}) {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: limit === undefined ? ['transfers', 'list'] : ['transfers', 'list', limit],
        queryFn: () => transfersList(limit),
        refetchInterval: 5000,
        enabled,
    })
    useEffect(
        () =>
            onAppEvent('transfers.changed', () => {
                queryClient.invalidateQueries({ queryKey: ['transfers', 'list'] })
            }),
        [queryClient]
    )

    const entries = useMemo(() => query.data ?? [], [query.data])
    const liveIds = useMemo(() => entries.filter(isLive).map((entry) => entry.id), [entries])
    const liveQuery = useQuery({
        queryKey: ['transfers', 'live', 'list', liveIds],
        queryFn: () => fetchLive(entries),
        enabled: liveIds.length > 0,
        refetchInterval: 2000,
        meta: { persist: false },
    })

    const rows = useMemo(
        () => toRows(entries, liveIds.length > 0 ? (liveQuery.data ?? {}) : {}),
        [entries, liveIds, liveQuery.data]
    )
    return { rows, query }
}
