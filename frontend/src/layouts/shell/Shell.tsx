import { Spinner, cn } from '@heroui/react'
import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { onBusy, setNavigate } from '../../../lib/api/navigation'
import { getSession } from '../../../lib/api/session'
import { hydrated } from '../../../lib/api/state'
import { initHostStore } from '../../../store/host'
import { usePersistedStore } from '../../../store/persisted'
import DialogHost from '../../components/DialogHost'
import Sidebar from './Sidebar'
import SiteHeader from './SiteHeader'
import { useSidebarState } from './useSidebarState'

/** Pages must not render before both documents have loaded: their first writes would carry defaults over what is saved. */
async function ensureHostStore() {
    await hydrated(usePersistedStore.persist)
    await initHostStore()
}

// The seam between the sidebar and the page: an invisible strip whose centre line lights up on
// hover, with a resize cursor pointing the way the sidebar will move, and a click toggles it.
// Not in the tab order; the header's button is the keyboard path.
function SidebarRail({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
    return (
        <button
            type="button"
            tabIndex={-1}
            onClick={onToggle}
            aria-label={label}
            title={label}
            className={cn(
                'absolute inset-y-0 z-20 w-4 -translate-x-1/2 outline-none transition-[left] duration-200 ease-out',
                // The highlight is a 2px border on a box that shares the sheet's top-left radius, so
                // it follows the corner's curve instead of crossing it. Paint only: the hit area
                // stays the strip itself.
                'after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-4 after:rounded-tl-2xl after:border-l-2 after:border-t-2 after:border-transparent after:transition-colors after:duration-150 hover:after:border-primary',
                // The app forces the default cursor everywhere (global.css); the rail is the one place
                // that should not.
                collapsed ? 'left-14 !cursor-e-resize' : 'left-64 !cursor-w-resize'
            )}
        />
    )
}

// The app's frame: a site header, the sidebar under it, and the page as a sheet inset in it.
export default function Shell() {
    const navigate = useNavigate()
    const location = useLocation()
    const [busy, setBusy] = useState(false)
    const { collapsed, toggle } = useSidebarState(location.pathname)
    const [authState, setAuthState] = useState<'checking' | 'ok'>('checking')

    useEffect(() => {
        setNavigate((to) => (typeof to === 'number' ? navigate(to) : navigate(to)))
        return () => setNavigate(null)
    }, [navigate])

    useEffect(() => onBusy(setBusy), [])

    useEffect(() => {
        let cancelled = false
        getSession()
            .then((session) => {
                if (cancelled) return
                if (!session.authenticated) {
                    navigate('/login', { replace: true })
                    return
                }
                return ensureHostStore().then(() => {
                    if (!cancelled) setAuthState('ok')
                })
            })
            .catch(() => {
                if (!cancelled) setAuthState('ok')
            })
        return () => {
            cancelled = true
        }
    }, [navigate])

    if (authState === 'checking') {
        return (
            <div className="flex items-center justify-center w-full h-screen">
                <Spinner />
            </div>
        )
    }

    return (
        <div className="flex flex-col w-full h-screen overflow-hidden bg-neutral-100 text-foreground dark:bg-black">
            <SiteHeader collapsed={collapsed} onToggle={toggle} />
            <div className="relative flex flex-row flex-1 min-h-0">
                <Sidebar collapsed={collapsed} />
                <SidebarRail collapsed={collapsed} onToggle={toggle} />
                <div className="relative flex-1 h-full min-w-0 overflow-auto browser-outlet rounded-tl-2xl border-l border-t border-divider bg-white text-foreground dark:border-neutral-800 dark:bg-[#121212]">
                    <Outlet />
                    {busy && <div className="absolute inset-0 z-40 bg-black/20" />}
                </div>
            </div>
            <DialogHost />
        </div>
    )
}
