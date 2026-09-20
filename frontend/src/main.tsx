// The pages talk to the server that served them (src/server). Every page is a route under the
// Shell.
import './global.css'
import { HeroUIProvider, ToastProvider } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React, { Suspense, lazy, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { forwardConsole } from '@/server/log'
import { connect, onReconnect } from '@/server/ws'
import { stateStorage, whenWritten } from '@/server/state'
import * as dialog from '@/dialog'
import queryClient from '@/lib/query'
import { useTheme } from '@/lib/theme'
import Shell from './layouts/shell/Shell'

// Every page is its own chunk: the code a route needs arrives when the route does (the Shell's
// Suspense shows a spinner meanwhile).
const Bisync = lazy(() => import('./pages/Bisync'))
const Commander = lazy(() => import('./pages/Commander'))
const Copy = lazy(() => import('./pages/Copy'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Delete = lazy(() => import('./pages/Delete'))
const Download = lazy(() => import('./pages/Download'))
const Login = lazy(() => import('./pages/Login'))
const Mount = lazy(() => import('./pages/Mount'))
const Move = lazy(() => import('./pages/Move'))
const Purge = lazy(() => import('./pages/Purge'))
const Remotes = lazy(() => import('./pages/Remotes'))
const Schedules = lazy(() => import('./pages/Schedules'))
const Serve = lazy(() => import('./pages/Serve'))
const SectionPage = lazy(() => import('./pages/Settings/SectionPage'))
const Sync = lazy(() => import('./pages/Sync'))
const Templates = lazy(() => import('./pages/Templates'))
const Transfers = lazy(() => import('./pages/Transfers'))
const Wizard = lazy(() => import('./pages/Wizard'))

// What the e2e suite drives from the devtools console: the dialogs, and the state adapter.
const api = { dialog, state: { stateStorage, whenWritten } }
;(window as unknown as { __RCLONE_CLOUD_API__: typeof api }).__RCLONE_CLOUD_API__ = api

connect()
// A socket that came back may have missed events: everything on screen asks again.
onReconnect(() => queryClient.invalidateQueries())

// Every page's console goes to the server's log file (rotated, so it can take all of it).
forwardConsole()

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
    // A drawer with a deep link is a route the page reads: `/transfers/<id>` opens the transfer,
    // `/schedules/<id>` the schedule, `/templates/new` (`?cmd=&name=` to start from) and
    // `/templates/<id>` the template drawers, over their lists.
    { path: '/transfers/:id?', element: <Transfers /> },
    { path: '/schedules/:id?', element: <Schedules /> },
    { path: '/templates/:id?', element: <Templates /> },
]

// Every page is a route under the Shell layout (sidebar + header); the login screen is not.
const router = createBrowserRouter([
    { path: '/login', element: <Suspense fallback={null}><Login /></Suspense> },
    {
        element: <Shell />,
        children: [
            { path: '/', element: <Dashboard /> },
            { path: '/settings/:section?', element: <SectionPage /> },
            // `/remotes/new` creates and `/remotes/<name>/edit` edits, over the list (a remote may be
            // called `new`, so editing is not `/remotes/<name>`).
            { path: '/remotes', element: <Remotes /> },
            { path: '/remotes/new', element: <Remotes /> },
            { path: '/remotes/:name/edit', element: <Remotes /> },
            // Plain questions that lead to an operation.
            { path: '/wizard', element: <Wizard /> },
            ...pageRoutes,
        ],
    },
])

function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme] = useTheme()

    useEffect(() => {
        if (theme === 'system') {
            const media = window.matchMedia('(prefers-color-scheme: dark)')
            const applySystem = () => {
                document.documentElement.classList.toggle('dark', media.matches)
            }

            applySystem()
            media.addEventListener('change', applySystem)

            return () => media.removeEventListener('change', applySystem)
        }

        document.documentElement.classList.toggle('dark', theme === 'dark')
    }, [theme])

    // The Shell is the one scroll root; this wraps, and scrolls nothing itself.
    return <main className="bg-transparent dark:bg-[#121212]">{children}</main>
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <HeroUIProvider>
                <ThemeProvider>
                    <RouterProvider router={router} />
                    <ToastProvider placement="bottom-right" />
                </ThemeProvider>
            </HeroUIProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
