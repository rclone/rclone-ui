import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { serves as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations, Serves } from '../../../lib/core/types'
import { followStart } from '../../../lib/mounts'

export function useServes(): Serves.ServeRow[] {
    const query = useQuery({ queryKey: coreKey('serves', 'List'), queryFn: () => api.List() })
    return useMemo(() => query.data ?? [], [query.data])
}

export class ServeFailedError extends Error {}

export async function startServe(args: Operations.ServeArgs): Promise<Serves.ServeRow> {
    return await followStart(
        'serves.changed',
        () => api.Start(args),
        async (id) => {
            const serve = (await api.List()).find((v) => v.id === id)
            return serve && { running: serve.state === 'running' }
        },
        (message) => new ServeFailedError(message)
    )
}

export async function stopServe(id: string): Promise<void> {
    await api.Stop(id)
}

export function serveLabel(serve: Serves.ServeRow): string {
    return `${serve.type.toUpperCase()} · ${serve.source} · ${serve.addr}`
}
