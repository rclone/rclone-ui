// What the host can do; pages hide UI the host can't back (updates, quitting).
// Filled by the server's boot script.

import { type ReactNode, createContext, useContext } from 'react'
import { type Capabilities, boot } from './boot'

export type { Capabilities }

export const capabilities: Capabilities = boot.capabilities
export const appVersion = boot.version

const CapabilitiesContext = createContext<Capabilities>(capabilities)

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
    return (
        <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>
    )
}

export function useCapabilities(): Capabilities {
    return useContext(CapabilitiesContext)
}
