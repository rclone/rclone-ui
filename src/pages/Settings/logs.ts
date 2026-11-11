import { useQuery } from '@tanstack/react-query'
import { logs as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'

/** The log files and the folder that holds them. */
export function useLogFiles() {
    return useQuery({ queryKey: coreKey('logs', 'Files'), queryFn: () => api.Files() })
}

/** The latest log lines of the core, oldest first, as "time level component: message". */
export async function lastLogLines(limit: number): Promise<string[]> {
    const records = await api.Tail(limit)
    return records.map((r) => {
        const at = r.time ? new Date(r.time).toISOString() : ''
        return `${at} ${r.level.toUpperCase()} ${r.component}: ${r.message}${r.object ? ` (${r.object})` : ''}`
    })
}
