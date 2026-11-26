import { useQuery } from '@tanstack/react-query'
import { tunnel as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Tunnel } from '../../../lib/core/types'

export function useTunnel() {
    return useQuery({ queryKey: coreKey('tunnel', 'Status'), queryFn: () => api.Status() })
}

export function startTunnel(): Promise<Tunnel.TunnelStatus> {
    return api.Start()
}

export async function stopTunnel(): Promise<void> {
    await api.Stop()
}
