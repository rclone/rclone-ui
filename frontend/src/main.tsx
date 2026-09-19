// The page's platform layer (lib/api) talks to the server that served it. Every page is a
// route under the Shell.
import './global.css'
import { HeroUIProvider, ToastProvider } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { CapabilitiesProvider } from '../lib/api/host'
import { forwardConsole } from '../lib/api/log'
import { connect } from '../lib/api/ws'
import * as api from '../lib/api'
import queryClient from '../lib/query'
import { reconnectRemote } from '../lib/rclone/api'
import { setReconnectHandler } from '../lib/rclone/client'
import { usePersistedStore } from '../store/persisted'
import Shell from './layouts/shell/Shell'
import Bisync from './pages/Bisync'
import Commander from './pages/Commander'
import Copy from './pages/Copy'
import Dashboard from './pages/Dashboard'
import Delete from './pages/Delete'
import Download from './pages/Download'
import Login from './pages/Login'
import Mount from './pages/Mount'
import Move from './pages/Move'
import Purge from './pages/Purge'
import Schedules from './pages/Schedules'
import Serve from './pages/Serve'
import SectionPage from './pages/Settings/SectionPage'
import Sync from './pages/Sync'
import Templates from './pages/Templates'
import Transfers from './pages/Transfers'
import Wizard from './pages/Wizard'

// The platform layer, reachable from the devtools console (and the e2e suite).
;(window as unknown as { __RCLONE_CLOUD_API__: typeof api }).__RCLONE_CLOUD_API__ = api

connect()

// Every page's console goes to the server's log file (rotated, so it can take all of it).
forwardConsole()

// The client's reconnect flow needs the API layer, which imports the client: wired here.
setReconnectHandler(reconnectRemote)

const pageRoutes = [
    { path: '/sync', element: <Sync /> },
    { path: '/copy', element: <Copy /> },
    { path: '/move', element: <Move /> },
    { path: '/delete', element: <Delete /> },
    { path: '/purge', element: <Purge /> },
    { path: '/download', element: <Download /> },
    { path: '/serve', element: <Serve /> },
    { path: '/bisync', element: <Bisync /> },
    { path: '/commander', element: <Commander /> },
    { path: '/mount', element: <Mount /> },
    { path: '/transfers', element: <Transfers /> },
    { path: '/schedules', element: <Schedules /> },
    { path: '/templates', element: <Templates /> },
]

// Every page is a route under the Shell layout (sidebar + header); the login screen is not.
const router = createBrowserRouter([
    { path: '/login', element: <Login /> },
    {
        element: <Shell />,
        children: [
            { path: '/', element: <Dashboard /> },
            { path: '/settings/:section?', element: <SectionPage /> },
            { path: '/remotes', element: <SectionPage section="remotes" /> },
            // Plain questions that lead to an operation.
            { path: '/wizard', element: <Wizard /> },
            ...pageRoutes,
        ],
    },
])

function ThemeProvider({ children }: { children: React.ReactNode }) {
    const theme = usePersistedStore((state) => state.appearance)

    useEffect(() => {
        if (theme.app === 'system') {
            const media = window.matchMedia('(prefers-color-scheme: dark)')
            const applySystem = () => {
                document.documentElement.classList.toggle('dark', media.matches)
            }

            applySystem()
            media.addEventListener('change', applySystem)

            return () => media.removeEventListener('change', applySystem)
        }

        const isDark = theme.app === 'dark'
        document.documentElement.classList.toggle('dark', isDark)
    }, [theme.app])

    return (
        <main className="bg-transparent dark:bg-[#121212] overflow-scroll overscroll-y-none">
            {children}
        </main>
    )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <HeroUIProvider>
                <CapabilitiesProvider>
                    <ThemeProvider>
                        <RouterProvider router={router} />
                        <ToastProvider placement="bottom-right" />
                    </ThemeProvider>
                </CapabilitiesProvider>
            </HeroUIProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
