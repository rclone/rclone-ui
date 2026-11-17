import { type ReactNode, createContext, useContext } from 'react'

const PreviewContext = createContext(false)

export function PreviewProvider({ children }: { children: ReactNode }) {
    return <PreviewContext.Provider value={true}>{children}</PreviewContext.Provider>
}

export function useIsPreview(): boolean {
    return useContext(PreviewContext)
}
