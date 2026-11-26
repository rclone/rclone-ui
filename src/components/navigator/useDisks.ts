import { useQuery } from '@tanstack/react-query'
import { browse as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

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
