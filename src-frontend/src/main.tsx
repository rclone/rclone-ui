// The page's platform layer (lib/api) talks to the server that served it: on the desktop the
// embedded server behind every native window, standalone a browser tab. Pages are the same;
// only the host's capabilities differ (a single-page Shell wraps them where there are no
// native windows).
import './global.css'
import { HeroUIProvider, ToastProvider } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { on as onAppEvent } from '../lib/api/events'
import { CapabilitiesProvider, capabilities } from '../lib/api/host'
import { forwardConsole } from '../lib/api/log'
import { windowSetTheme } from '../lib/api/native'
import { connect } from '../lib/api/ws'
import * as api from '../lib/api'
import queryClient from '../lib/query'
import { reconnectRemote } from '../lib/rclone/api'
import { clearClient, setReconnectHandler } from '../lib/rclone/client'
import { initHostStore } from '../store/host'
import { usePersistedStore } from '../store/persisted'
import DialogHost from './components/DialogHost'
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
import Settings from './pages/Settings'
import SectionPage from './pages/Settings/SectionPage'
import Startup from './pages/Startup'
import Sync from './pages/Sync'
import Templates from './pages/Templates'
import Test from './pages/Test'
import Toolbar from './pages/Toolbar'
import Transfers from './pages/Transfers'
import Wizard from './pages/Wizard'

const nativeWindows = capabilities.window

// index.html adds this before first paint; keep it in sync for anything that renders index.html
// without the boot script (tests, a raw Vite tab).
document.documentElement.classList.toggle('browser', !nativeWindows)

// The platform layer, reachable from the devtools console (and the e2e suite).
;(window as unknown as { __RCLONE_UI_API__: typeof api }).__RCLONE_UI_API__ = api

connect()

// Every page's console goes to the host's log file (rotated, so it can take all of it): the
// desktop's windows into `Rclone UI.log`, browser tabs into the server's own log.
forwardConsole()

if (
    nativeWindows &&
    !window.location?.pathname.startsWith('/toolbar') &&
    !window.location?.pathname.startsWith('/startup') &&
    !window.location?.pathname.startsWith('/commander')
) {
    import('./setupDragRegions').then(({ initDragRegions }) => {
        initDragRegions()
    })
}

// The client's reconnect flow needs the API layer, which imports the client: wired here.
setReconnectHandler(reconnectRemote)

// placed here to avoid circular dependency
usePersistedStore.subscribe(async (state, prevState) => {
    if (state.currentHostId !== prevState.currentHostId && state.currentHostId) {
        console.log('[Store] Host changed to', state.currentHostId)
        await initHostStore(state.currentHostId).catch(console.error)
        // Hydration sets the first host; nothing was fetched from another host before it.
        if (!prevState.currentHostId) return
        clearClient()
        // Drops the previous host's data and refetches whatever is on screen. A plain clear()
        // destroyed fetches already in flight for the new host and left their observers (the
        // sidebar's status card, which fires before this runs) pending for good.
        await queryClient.resetQueries()
    }
})

// Shared by both hosts; the settings differ (a tabbed window on the desktop, one section per
// route under the Shell).
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

// The desktop opens one native window per page; a browser tab nests the same pages under the
// Shell layout (sidebar + dashboard + login). Toolbar and Startup exist only as native windows.
const router = createBrowserRouter(
    nativeWindows
        ? [
              { path: '/', element: <Dashboard /> },
              { path: '/startup', element: <Startup /> },
              { path: '/settings', element: <Settings /> },
              ...pageRoutes,
              { path: '/toolbar', element: <Toolbar /> },
              { path: '/test', element: <Test /> },
          ]
        : [
              { path: '/login', element: <Login /> },
              {
                  element: <Shell />,
                  children: [
                      { path: '/', element: <Dashboard /> },
                      { path: '/settings/:section?', element: <SectionPage /> },
                      { path: '/remotes', element: <SectionPage section="remotes" /> },
                      // Plain questions that lead to an operation; the desktop's launcher has no need of it.
                      { path: '/wizard', element: <Wizard /> },
                      ...pageRoutes,
                  ],
              },
          ]
)

if (nativeWindows) {
    onAppEvent('theme.changed', ({ theme }) => {
        console.log('theme changed', theme)
        // Only react to theme changes when user preference is set to "system"
        if (usePersistedStore.getState().appearance.app === 'system') {
            document.documentElement.classList.toggle('dark', theme === 'dark')
        }
    })
}

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
            windowSetTheme(null).catch(() => {})

            return () => media.removeEventListener('change', applySystem)
        }

        const isDark = theme.app === 'dark'
        document.documentElement.classList.toggle('dark', isDark)
        windowSetTheme(isDark ? 'dark' : 'light').catch(() => {})
    }, [theme.app])

    return (
        <main
            className={
                window.location?.pathname.startsWith('/toolbar') ||
                window.location?.pathname.startsWith('/startup')
                    ? undefined
                    : 'bg-transparent dark:bg-[#121212] overflow-scroll overscroll-y-none'
            }
        >
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
                        {nativeWindows && <DialogHost />}
                        {!nativeWindows && <ToastProvider placement="bottom-right" />}
                    </ThemeProvider>
                </CapabilitiesProvider>
            </HeroUIProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
