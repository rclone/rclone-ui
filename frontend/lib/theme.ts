import { useEffect, useState } from 'react'

// The tab's theme, kept in this browser (like the sidebar's state), not in the server's document:
// two people on one server may want two themes. index.html reads the same key before the bundle
// loads, so the first paint is already right.
export type Theme = 'light' | 'dark' | 'system'

const KEY = 'shell.theme'
const listeners = new Set<(theme: Theme) => void>()

export function getTheme(): Theme {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
}

export function setTheme(theme: Theme) {
    localStorage.setItem(KEY, theme)
    for (const listener of listeners) listener(theme)
}

export function useTheme(): [Theme, (theme: Theme) => void] {
    const [theme, set] = useState<Theme>(getTheme)
    useEffect(() => {
        listeners.add(set)
        return () => {
            listeners.delete(set)
        }
    }, [])
    return [theme, setTheme]
}
