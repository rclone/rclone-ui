import { t } from '@lingui/core/macro'
import {
    ArrowsRotate as ArrowsRotateIcon,
    Bell as BellIcon,
    Clock as ClockIcon,
    Cloud as CloudIcon,
    Compass as CompassIcon,
    DownloadBracket as DownloadBracketIcon,
    FolderConnection as FolderConnectionIcon,
    Gear as GearIcon,
    GraduationCap as GraduationCapIcon,
    HardDrive as HardDriveIcon,
    Inbox as InboxIcon,
    LayerGroup as LayerGroupIcon,
    Layout1 as Layout1Icon,
    Mobile as MobileIcon,
    Page as PageIcon,
    PlayCircle as PlayCircleIcon,
    Repeat as RepeatIcon,
    SendAlt as SendAltIcon,
    TowerBroadcast as TowerBroadcastIcon,
    Trash as TrashIcon,
    TrashSimple as TrashSimpleIcon,
} from '@zappicon/react'
import type { ComponentType } from 'react'
import type { Tone } from './components/look/tones'

// Every page that a window can show, by the first segment of its route. main.tsx builds the
// router and the frame around the page from this table. Go keeps its own window shapes
// (ForRoute in app/windows), because the tray, toasts and deep links open a window from its URL
// alone.

export interface WindowLook {
    title: string
    icon: typeof PageIcon
    tone: Tone
}

export interface RouteDef {
    /** Loads the page in its own chunk, so that a window loads only the page that it shows. */
    page: () => Promise<{ default: ComponentType }>
    /**
     * The window's look. Its header, its empty states and its main button use it, and so do the
     * guides and the cards that open the window, so a window looks the same wherever it appears.
     * It also gives the window its title when that isn't the route's name (main.tsx).
     */
    look?: WindowLook
    /**
     * The form that a new route can replace, which the "Replace what you entered…?" question
     * names (replaceQuestion in route.ts). A transfer takes a source and a destination
     * ('from-to'), and the other forms take a single path ('one').
     */
    form?: 'from-to' | 'one'
    /**
     * How the page meets the edges of its window. A 'bare' page draws its whole window, with
     * nothing around it. An 'edge' page reaches the top of the window itself, so on macOS no strip
     * is kept under the window's buttons.
     */
    frame?: 'bare' | 'edge'
    /** False when the window's tone doesn't wash down from its top. */
    wash?: false
    /** Only a dev build has the page. */
    dev?: true
}

// An operation's option group has the look of its window (OptionsAccordion): copying is blue,
// syncing green, mounting violet, serving cyan.
export const ROUTES = {
    // The startup screen is frameless, with no title bar.
    startup: { page: () => import('./pages/Startup'), frame: 'bare' },
    settings: {
        page: () => import('./pages/Settings'),
        look: { title: t`Settings`, icon: GearIcon, tone: 'graphite' },
    },
    remotes: {
        page: () => import('./pages/Remotes'),
        look: { title: t`Remotes`, icon: CloudIcon, tone: 'blue' },
    },
    notifications: {
        page: () => import('./pages/Notifications'),
        look: { title: t`Notifications`, icon: BellIcon, tone: 'red' },
    },
    // Its header and the launcher call it "Remote Control" for short.
    mobileRemoteControl: {
        page: () => import('./pages/MobileRemoteControl'),
        look: { title: t`Mobile & Remote Control`, icon: MobileIcon, tone: 'indigo' },
    },
    sync: {
        page: () => import('./pages/Sync'),
        look: { title: t`Sync`, icon: ArrowsRotateIcon, tone: 'green' },
        form: 'from-to',
    },
    copy: {
        page: () => import('./pages/Copy'),
        look: { title: t`Copy`, icon: PageIcon, tone: 'blue' },
        form: 'from-to',
    },
    move: {
        page: () => import('./pages/Move'),
        look: { title: t`Move`, icon: SendAltIcon, tone: 'blue' },
        form: 'from-to',
    },
    delete: {
        page: () => import('./pages/Delete'),
        look: { title: t`Delete`, icon: TrashSimpleIcon, tone: 'red' },
        form: 'one',
    },
    purge: {
        page: () => import('./pages/Purge'),
        look: { title: t`Purge`, icon: TrashIcon, tone: 'red' },
        form: 'one',
    },
    download: {
        page: () => import('./pages/Download'),
        look: { title: t`Download`, icon: DownloadBracketIcon, tone: 'orange' },
        form: 'one',
    },
    serve: {
        page: () => import('./pages/Serve'),
        look: { title: t`Serve`, icon: TowerBroadcastIcon, tone: 'cyan' },
        form: 'one',
    },
    bisync: {
        page: () => import('./pages/Bisync'),
        look: { title: t`Bisync`, icon: RepeatIcon, tone: 'lime' },
        form: 'from-to',
    },
    // Commander's panels reach the top of the window.
    commander: {
        page: () => import('./pages/Commander'),
        look: { title: t`Commander`, icon: Layout1Icon, tone: 'blue' },
        frame: 'edge',
    },
    mount: {
        page: () => import('./pages/Mount'),
        look: { title: t`Mount`, icon: HardDriveIcon, tone: 'violet' },
        form: 'one',
    },
    history: {
        page: () => import('./pages/History'),
        look: { title: t`History`, icon: InboxIcon, tone: 'indigo' },
    },
    templates: {
        page: () => import('./pages/Templates'),
        look: { title: t`Templates`, icon: LayerGroupIcon, tone: 'fuchsia' },
    },
    watchers: {
        page: () => import('./pages/Watchers'),
        look: { title: t`Watchers`, icon: FolderConnectionIcon, tone: 'green' },
    },
    schedules: {
        page: () => import('./pages/Schedules'),
        look: { title: t`Schedules`, icon: ClockIcon, tone: 'orange' },
    },
    automounts: {
        page: () => import('./pages/Automounts'),
        look: { title: t`Automounts`, icon: PlayCircleIcon, tone: 'violet' },
    },
    // The launcher's "Run" opens it, so its window takes that title rather than "Wizard".
    wizard: {
        page: () => import('./pages/Wizard'),
        look: { title: t`Run`, icon: CompassIcon, tone: 'blue' },
    },
    // Nothing tints the guides, which are there to be read.
    guides: {
        page: () => import('./pages/Guides'),
        look: { title: t`Guides`, icon: GraduationCapIcon, tone: 'graphite' },
        wash: false,
    },
    // The launcher's window on Linux (app/launcher/view/linux). macOS and Windows draw it natively.
    launcher: { page: () => import('./pages/Launcher'), frame: 'bare' },
    // A page that shows the core's status, the app's info and its events. A release build drops
    // the import, and so the page's chunk, because import.meta.env.DEV is false there.
    test: {
        page: import.meta.env.DEV
            ? () => import('./pages/Test')
            : () => Promise.reject(new Error('The test page is only in a dev build')),
        dev: true,
    },
} satisfies Record<string, RouteDef>

export type RouteName = keyof typeof ROUTES

/** Whether this build has the route's page. A release build leaves out the dev pages. */
export function isBuilt(def: RouteDef): boolean {
    return !def.dev || import.meta.env.DEV
}

/**
 * The route that a URL opens ("/schedules?id=1" or "/sync/x"), by the first segment of its
 * path. Both are undefined for a path that no page of this build has.
 */
export function routeOf(url: string): { name?: RouteName; def?: RouteDef } {
    const segment = new URL(url, 'wails://localhost').pathname.split('/').find(Boolean) ?? ''
    if (!Object.hasOwn(ROUTES, segment)) return {}
    const name = segment as RouteName
    const def: RouteDef = ROUTES[name]
    return isBuilt(def) ? { name, def } : {}
}

/** The routes whose window has a look of its own. */
export type WindowName = {
    [K in RouteName]: (typeof ROUTES)[K] extends { look: WindowLook } ? K : never
}[RouteName]

/** Every window's look, by its route's name (RouteDef.look). */
export const WINDOWS = Object.fromEntries(
    Object.entries(ROUTES).flatMap(([name, def]: [string, RouteDef]) =>
        def.look ? [[name, def.look]] : []
    )
) as Record<WindowName, WindowLook>
