import type { QueryKey } from '@tanstack/react-query'

/**
 * The query key for a core call: `['core', service, method, input]`. A core event marks queries
 * stale by the start of this key (`invalidates` in lib/live.ts). The input tells apart two calls
 * to the same method.
 */
export function coreKey(service: string, method: string, input?: unknown): QueryKey {
    return ['core', service, method, input ?? {}]
}
