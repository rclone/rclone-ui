import { useQuery } from '@tanstack/react-query'
import { app as api } from './core/api'
import { coreKey } from './core/query'

/** The core's versions and folders, such as rclone's and Go's versions and the data folder. */
export function useAppInfo() {
    return useQuery({ queryKey: coreKey('app', 'Info'), queryFn: () => api.Info() })
}
