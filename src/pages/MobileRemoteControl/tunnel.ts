import { useQuery } from '@tanstack/react-query'
import { tunnel as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Tunnel } from '../../../lib/core/types'

// The remote tunnel, as the Mobile & Remote Control window uses it (core/tunnel). tunnel.changed
// keeps the status fresh, so the writes here only call the core.

/** The tunnel's status, with its address and credentials while it is on. */
export function useTunnel() {
    return useQuery({ queryKey: coreKey('tunnel', 'Status'), queryFn: () => api.Status() })
}

/** Turns the tunnel on. It returns once the core has started it. */
export function startTunnel(): Promise<Tunnel.TunnelStatus> {
    return api.Start()
}

export async function stopTunnel(): Promise<void> {
    await api.Stop()
}
