import { useQuery } from '@tanstack/react-query'
import { logs as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

export function useLogFiles() {
    return useQuery({ queryKey: coreKey('logs', 'Files'), queryFn: () => api.Files() })
}

export async function lastLogLines(limit: number): Promise<string[]> {
    const records = await api.Tail(limit)
    return records.map((r) => {
        const at = r.time ? new Date(r.time).toISOString() : ''
        return `${at} ${r.level.toUpperCase()} ${r.component}: ${r.message}${r.object ? ` (${r.object})` : ''}`
    })
}
