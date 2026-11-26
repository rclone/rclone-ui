import './global.css'
import { HeroUIProvider, ToastProvider } from '@heroui/react'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React, {
    type CSSProperties,
    Fragment,
    lazy,
    type ReactNode,
    Suspense,
    useEffect,
} from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { languageOf, locale, switchLanguage } from '../lib/i18n'
import { useCoreEvents, useShellEvents } from '../lib/live'
import { usePref, usePrefsLoaded } from '../lib/prefs'
import { useSettings } from '../lib/settings'
import { currentWindow, forwardConsole, platform, systemLanguage } from '../lib/shell'
import { reportPageErrors } from '../lib/telemetry'
import DialogHost from './components/DialogHost'
import { TONE_RGB } from './components/look/tones'
import ErrorBoundary from './ErrorBoundary'
import queryClient from './query'
import { FormEdited, routeToFollow, useFollowedRoute } from './route'
import { isBuilt, ROUTES, type RouteDef, routeOf } from './routes'

forwardConsole()
reportPageErrors()
console.info('[boot]', window.location.pathname)

function CoreEvents() {
    useCoreEvents(queryClient)
    useShellEvents(queryClient)
    return null
}

function FollowsQuery({ children }: { children: ReactNode }) {
    const { key, edited } = useFollowedRoute()
    return (
        <FormEdited.Provider value={edited}>
            <Fragment key={key}>{children}</Fragment>
        </FormEdited.Provider>
    )
}

const router = createBrowserRouter(
    Object.entries(ROUTES).flatMap(([name, def]: [string, RouteDef]) => {
        if (!isBuilt(def)) return []
        const Page = lazy(def.page)
        return {
            path: `/${name}`,
            element: (
                <FollowsQuery>
                    <ErrorBoundary>
                        <Suspense fallback={null}>
                            <Page />
                        </Suspense>
                    </ErrorBoundary>
                </FollowsQuery>
            ),
        }
    })
)

function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme] = usePref('theme')
    const loaded = usePrefsLoaded()
    useEffect(() => {
        if (!loaded) return
        localStorage.setItem('theme', theme)
        if (theme === 'system') {
            const media = window.matchMedia('(prefers-color-scheme: dark)')
            const apply = () => document.documentElement.classList.toggle('dark', media.matches)
            apply()
            media.addEventListener('change', apply)
            currentWindow.setTheme(null).catch(() => undefined)
            return () => media.removeEventListener('change', apply)
        }
        document.documentElement.classList.toggle('dark', theme === 'dark')
        currentWindow.setTheme(theme).catch(() => undefined)
    }, [theme, loaded])

    const { def } = routeOf(window.location?.pathname ?? '/')
    const look = def?.look
    const wash = look && def.wash !== false ? 'tone-wash' : ''
    const bare = def?.frame === 'bare'
    const titleStrip = platform() === 'macos' && !def?.frame
    return (
        <main
            className={
                bare
                    ? undefined
                    : `bg-transparent dark:bg-[#121212] overflow-scroll overscroll-y-none ${wash}`
            }
            style={look ? ({ '--tone': TONE_RGB[look.tone] } as CSSProperties) : undefined}
        >
            {titleStrip && (
                <div
                    aria-hidden={true}
                    className={`fixed inset-x-0 top-0 z-40 h-7 pointer-events-none bg-background dark:bg-[#121212] ${wash}`}
                />
            )}
            {children}
        </main>
    )
}

const title = routeOf(window.location.pathname).def?.look?.title
if (title && title !== currentWindow.name()) {
    currentWindow.setTitle(title).catch(() => undefined)
}

function FollowsLanguage() {
    const { settings } = useSettings()
    const wanted = settings && languageOf(settings.general.language, systemLanguage())
    useEffect(() => {
        if (wanted) switchLanguage(wanted)
    }, [wanted])
    return null
}

currentWindow.onRoute((url) => {
    const route = routeToFollow(url, window.location)
    if (route) router.navigate(route, { replace: true })
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <CoreEvents />
            <FollowsLanguage />
            <I18nProvider i18n={i18n}>
                <HeroUIProvider locale={locale()}>
                    <ThemeProvider>
                        <RouterProvider router={router} />
                    </ThemeProvider>
                    <DialogHost />
                    <ToastProvider placement="bottom-right" />
                </HeroUIProvider>
            </I18nProvider>
        </QueryClientProvider>
    </React.StrictMode>
)
