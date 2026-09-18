import { useEffect, useState } from 'react'

const COLLAPSED_KEY = 'shell.sidebarCollapsed'

// The expanded/collapsed state, remembered across loads. The Commander wants the width for its
// two panels, so opening it collapses the sidebar; that sticks like a toggle would, and nothing
// reopens it on the way out.
export function useSidebarState(pathname: string) {
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
    const onCommander = pathname.startsWith('/commander')
    useEffect(() => {
        if (!onCommander) return
        setCollapsed(true)
        localStorage.setItem(COLLAPSED_KEY, 'true')
    }, [onCommander])

    const toggle = () => {
        setCollapsed(!collapsed)
        localStorage.setItem(COLLAPSED_KEY, String(!collapsed))
    }
    return { collapsed, toggle }
}
