import { useQuery } from '@tanstack/react-query'
import { browse as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

/**
 * The disks and folders on this machine, as reported by the core (browse.Disks). It is undefined
 * until they arrive, and an empty list if the call fails.
 */
export default function useDisks(enabled = true): string[] | undefined {
    const { data, isError } = useQuery({
        queryKey: coreKey('browse', 'Disks'),
        queryFn: async () => (await api.Disks()) ?? [],
        enabled,
        staleTime: 60_000,
    })
    if (isError) return []
    return data
}
