import type { QueryKey } from '@tanstack/react-query'

export function coreKey(service: string, method: string, input?: unknown): QueryKey {
    return ['core', service, method, input ?? {}]
}
