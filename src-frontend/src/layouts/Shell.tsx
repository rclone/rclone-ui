import { Spinner, cn } from '@heroui/react'
import {
    ActivityIcon,
    ArrowLeftRightIcon,
    ChevronDownIcon,
    ClockIcon,
    CopyIcon,
    DownloadIcon,
    FlameIcon,
    FolderTreeIcon,
    HardDriveIcon,
    LayoutDashboardIcon,
    LayoutTemplateIcon,
    LogOutIcon,
    MoveIcon,
    RefreshCwIcon,
    ServerIcon,
    SettingsIcon,
    TerminalIcon,
    Trash2Icon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { authRequired } from '../../lib/api/host'
import { onBusy, setNavigate } from '../../lib/api/navigation'
import { hydrated } from '../../lib/api/state'
import { LOCAL_HOST_ID, makeLocalHost } from '../../lib/hosts'
import { useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import DialogHost from '../components/DialogHost'

/** A fresh data dir has no hosts at all; the rclone client needs a current host to build a URL. */
async function ensureLocalHost() {
    await hydrated(usePersistedStore.persist)
    const state = usePersistedStore.getState()
    const hasLocal = state.hosts.some((host) => host.id === LOCAL_HOST_ID)
    if (hasLocal && state.currentHostId) return
    usePersistedStore.setState((prev) => ({
        hosts: hasLocal ? prev.hosts : [...prev.hosts, makeLocalHost()],
        currentHostId: prev.currentHostId ?? LOCAL_HOST_ID,
    }))
}

/**
 * The host's document loads after the app's (a current host is needed to name it). Pages must
 * not render before it has: their first writes would carry defaults over what is saved.
 */
async function ensureHostStore() {
    await ensureLocalHost()
    await hydrated(useHostStore.persist)
}

// Browser mode's single window: the desktop's per-operation windows become routes inside this
// layout, and the toolbar's launcher becomes the sidebar. The rclone commands sit in a
// collapsible group so the sidebar stays short.
interface NavEntry {
    to: string
    label: string
    icon: typeof CopyIcon
}

const PAGES: NavEntry[] = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
    { to: '/commander', label: 'Commander', icon: FolderTreeIcon },
    { to: '/transfers', label: 'Transfers', icon: ActivityIcon },
]

const COMMANDS: NavEntry[] = [
    { to: '/copy', label: 'Copy', icon: CopyIcon },
    { to: '/move', label: 'Move', icon: MoveIcon },
    { to: '/sync', label: 'Sync', icon: RefreshCwIcon },
    { to: '/bisync', label: 'Bisync', icon: ArrowLeftRightIcon },
    { to: '/download', label: 'Download', icon: DownloadIcon },
    { to: '/mount', label: 'Mount', icon: HardDriveIcon },
    { to: '/serve', label: 'Serve', icon: ServerIcon },
    { to: '/delete', label: 'Delete', icon: Trash2Icon },
    { to: '/purge', label: 'Purge', icon: FlameIcon },
]

const MORE: NavEntry[] = [
    { to: '/schedules', label: 'Schedules', icon: ClockIcon },
    { to: '/templates', label: 'Templates', icon: LayoutTemplateIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

const COMMANDS_OPEN_KEY = 'shell.commandsOpen'

function NavItem({ to, label, icon: Icon, nested = false }: NavEntry & { nested?: boolean }) {
    return (
        <NavLink
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
                cn(
                    'flex items-center gap-3 py-2 text-sm rounded-large transition-colors',
                    nested ? 'pl-9 pr-3' : 'px-3',
                    isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-white/10'
                )
            }
        >
            <Icon className="w-4 h-4" />
            <span>{label}</span>
        </NavLink>
    )
}

export default function Shell() {
    const navigate = useNavigate()
    const location = useLocation()
    const [busy, setBusy] = useState(false)
    const onCommandRoute = COMMANDS.some((entry) => location.pathname.startsWith(entry.to))
    // Remembered across navigations; a command route opens the group regardless.
    const [commandsOpen, setCommandsOpen] = useState(
        () => localStorage.getItem(COMMANDS_OPEN_KEY) === 'true'
    )
    const showCommands = commandsOpen || onCommandRoute
    const toggleCommands = () => {
        const next = !showCommands
        setCommandsOpen(next)
        localStorage.setItem(COMMANDS_OPEN_KEY, String(next))
    }
    const [authState, setAuthState] = useState<'checking' | 'ok'>('checking')

    useEffect(() => {
        setNavigate((to) => (typeof to === 'number' ? navigate(to) : navigate(to)))
        return () => setNavigate(null)
    }, [navigate])

    useEffect(() => onBusy(setBusy), [])

    useEffect(() => {
        let cancelled = false
        fetch('/api/session', { credentials: 'same-origin' })
            .then((r) => r.json() as Promise<{ required: boolean; authenticated: boolean }>)
            .then((session) => {
                if (cancelled) return
                if (session.required && !session.authenticated) {
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
        <div className="flex flex-row w-full h-screen overflow-hidden bg-black text-white">
            <nav className="flex flex-col flex-shrink-0 h-full gap-1 px-2 py-3 overflow-y-auto w-64 bg-black">
                <div className="flex items-center gap-2 px-3 py-2 mb-2">
                    <img src="/icon.png" alt="" className="w-7 h-7 rounded-md" />
                    <span className="font-semibold">Rclone</span>
                </div>
                {PAGES.map((entry) => (
                    <NavItem key={entry.to} {...entry} />
                ))}
                <button
                    type="button"
                    onClick={toggleCommands}
                    aria-expanded={showCommands}
                    aria-controls="shell-commands"
                    className={cn(
                        'flex items-center gap-3 px-3 py-2 text-sm rounded-large transition-colors',
                        onCommandRoute && !showCommands ? 'bg-white/10' : 'hover:bg-white/10'
                    )}
                >
                    <TerminalIcon className="w-4 h-4" />
                    <span>Commands</span>
                    <ChevronDownIcon
                        className={cn(
                            'w-4 h-4 ml-auto transition-transform text-default-400',
                            showCommands && 'rotate-180'
                        )}
                    />
                </button>
                {showCommands && (
                    <div id="shell-commands" className="flex flex-col gap-1">
                        {COMMANDS.map((entry) => (
                            <NavItem key={entry.to} {...entry} nested={true} />
                        ))}
                    </div>
                )}
                {MORE.map((entry) => (
                    <NavItem key={entry.to} {...entry} />
                ))}
                <div className="flex-grow" />
                {authRequired && (
                    <button
                        type="button"
                        onClick={async () => {
                            await fetch('/api/logout', {
                                method: 'POST',
                                credentials: 'same-origin',
                            })
                            navigate('/login', { replace: true })
                        }}
                        className="flex items-center gap-3 px-3 py-2 mt-2 text-sm rounded-large text-neutral-400 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        <LogOutIcon className="w-4 h-4" />
                        <span>Sign out</span>
                    </button>
                )}
            </nav>
            <div className="relative flex-1 h-full min-w-0 overflow-auto browser-outlet rounded-tl-2xl border-l border-divider bg-white text-foreground dark:border-neutral-800 dark:bg-[#121212]">
                <Outlet />
                {busy && <div className="absolute inset-0 z-40 bg-black/20" />}
            </div>
            <DialogHost />
        </div>
    )
}
