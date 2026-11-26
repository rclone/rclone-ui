import { useQuery } from '@tanstack/react-query'
import { app as api } from './core/api'
import { coreKey } from './core/query'

export function useAppInfo() {
    return useQuery({ queryKey: coreKey('app', 'Info'), queryFn: () => api.Info() })
}
