import './global.css'
import { HeroUIProvider } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { debug, error, info, trace, warn } from '@tauri-apps/plugin-log'
import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import queryClient from '../lib/query'
import { clearClient } from '../lib/rclone/client'
import { initHostStore } from '../store/host'
import { usePersistedStore } from '../store/persisted'
import Bisync from './pages/Bisync'
import Commander from './pages/Commander'
import Copy from './pages/Copy'
import Delete from './pages/Delete'
import Download from './pages/Download'
import Home from './pages/Home'
import Mount from './pages/Mount'
import Move from './pages/Move'
import Purge from './pages/Purge'
import Schedules from './pages/Schedules'
import Serve from './pages/Serve'
import Settings from './pages/Settings'
import Startup from './pages/Startup'
import Sync from './pages/Sync'
import Templates from './pages/Templates'
import Test from './pages/Test'
import Toolbar from './pages/Toolbar'
import Transfers from './pages/Transfers'

function forwardConsole(
    fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
    logger: (message: string) => Promise<void>
) {
    const original = console[fnName]
    console[fnName] = (message, ...args) => {
        original(message, ...args)
        try {
            logger(
                `${message} ${args?.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`
            )
        } catch (e: any) {
            console.error(e.message)
        }
    }
}

forwardConsole('log', trace)
forwardConsole('debug', debug)
forwardConsole('info', info)
forwardConsole('warn', warn)
forwardConsole('error', error)

if (
    !window.location?.pathname.startsWith('/toolbar') &&
    !window.location?.pathname.startsWith('/startup') &&
    !window.location?.pathname.startsWith('/commander')
) {
    import('./setupDragRegions').then(({ initTauriDragRegions }) => {
        initTauriDragRegions()
    })
}

// placed here to avoid circular dependency
usePersistedStore.subscribe(async (state, prevState) => {
    if (state.currentHostId !== prevState.currentHostId && state.currentHostId) {
        console.log('[Store] Host changed to', state.currentHostId)
        await initHostStore(state.currentHostId).catch(console.error)
        await queryClient.cancelQueries()
        clearClient()
        queryClient.clear()
    }
})

const router = createBrowserRouter([
    {
        path: '/',
        element: <Home />,
    },
    {
        path: '/startup',
        element: <Startup />,
    },
    {
        path: '/settings',
        element: <Settings />,
    },
    {
        path: '/sync',
        element: <Sync />,
    },
    {
        path: '/copy',
        element: <Copy />,
    },
    {
        path: '/move',
        element: <Move />,
    },
    {
        path: '/delete',
        element: <Delete />,
    },
    {
        path: '/purge',
        element: <Purge />,
    },
    {
        path: '/download',
        element: <Download />,
    },
    {
        path: '/serve',
        element: <Serve />,
    },
    {
        path: '/bisync',
        element: <Bisync />,
    },
    {
        path: '/commander',
        element: <Commander />,
    },
    {
        path: '/mount',
        element: <Mount />,
    },
    {
        path: '/transfers',
        element: <Transfers />,
    },
    {
        path: '/schedules',
        element: <Schedules />,
    },
    {
        path: '/templates',
        element: <Templates />,
    },
    {
        path: '/toolbar',
        element: <Toolbar />,
    },
    {
        path: '/test',
        element: <Test />,
    },
])

getCurrentWindow().onThemeChanged((event) => {
    console.log('theme changed', event)
    // Only react to theme changes when user preference is set to "system"
    if (usePersistedStore.getState().appearance.app === 'system') {
        const isDark = event.payload === 'dark'
        document.documentElement.classList.toggle('dark', isDark)
    }
})

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
            getCurrentWindow().setTheme(null)

            return () => media.removeEventListener('change', applySystem)
        }

        const isDark = theme.app === 'dark'
        document.documentElement.classList.toggle('dark', isDark)
        getCurrentWindow().setTheme(isDark ? 'dark' : 'light')
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
                <ThemeProvider>
                    <RouterProvider router={router} />
                </ThemeProvider>
            </HeroUIProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
