// What the host can do; pages hide UI the host can't back (native windows, the tunnel, OS-level
// integration). Same shape on both products, filled by the server's boot script.

import { type ReactNode, createContext, useContext } from 'react'
import { type Capabilities, boot } from './boot'

export type { Capabilities }

export const capabilities: Capabilities = boot.capabilities
export const mode = boot.mode
export const isDesktop = boot.mode === 'desktop'
export const appVersion = boot.version
export const authRequired = boot.authRequired

const CapabilitiesContext = createContext<Capabilities>(capabilities)

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
    return (
        <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>
    )
}

export function useCapabilities(): Capabilities {
    return useContext(CapabilitiesContext)
}

/** True when the page runs inside the desktop app's own window (native affordances exist). */
export function useIsDesktop(): boolean {
    return useCapabilities().mode === 'desktop'
}
