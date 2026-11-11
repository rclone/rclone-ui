// Serve helpers for the pages. Each serve is a child process of the core, which uses the config
// it was started with (core/serves). The serves.changed event keeps the queries fresh and reports
// when a start has succeeded or failed.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { serves as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations, Serves } from '../../../lib/core/types'
import { followStart } from '../../../lib/mounts'

/** The running serves, oldest first. */
export function useServes(): Serves.ServeRow[] {
    const query = useQuery({ queryKey: coreKey('serves', 'List'), queryFn: () => api.List() })
    return useMemo(() => query.data ?? [], [query.data])
}

/** A serve that failed to start. Its message is the error from rclone or the core. */
export class ServeFailedError extends Error {}

/**
 * Starts a serve and returns it once its address accepts connections. If the serve fails, it
 * throws a ServeFailedError with the child process's error.
 */
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

/** Stops a serve and returns once it has stopped. */
export async function stopServe(id: string): Promise<void> {
    await api.Stop(id)
}

export function serveLabel(serve: Serves.ServeRow): string {
    return `${serve.type.toUpperCase()} · ${serve.source} · ${serve.addr}`
}
