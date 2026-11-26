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

export interface WindowLook {
    title: string
    icon: typeof PageIcon
    tone: Tone
}

export interface RouteDef {
    page: () => Promise<{ default: ComponentType }>
    look?: WindowLook
    form?: 'from-to' | 'one'
    frame?: 'bare' | 'edge'
    wash?: false
    dev?: true
}

export const ROUTES = {
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
    wizard: {
        page: () => import('./pages/Wizard'),
        look: { title: t`Run`, icon: CompassIcon, tone: 'blue' },
    },
    guides: {
        page: () => import('./pages/Guides'),
        look: { title: t`Guides`, icon: GraduationCapIcon, tone: 'graphite' },
        wash: false,
    },
    launcher: { page: () => import('./pages/Launcher'), frame: 'bare' },
    test: {
        page: import.meta.env.DEV
            ? () => import('./pages/Test')
            : () => Promise.reject(new Error('The test page is only in a dev build')),
        dev: true,
    },
} satisfies Record<string, RouteDef>

export type RouteName = keyof typeof ROUTES

export function isBuilt(def: RouteDef): boolean {
    return !def.dev || import.meta.env.DEV
}

/**
 * The scheme must be a standard one such as http. WebView2 before Chromium 130 can't resolve a
 * path against a custom scheme such as wails://, and throws "Invalid URL" (#262).
 */
export const ROUTE_BASE = 'http://localhost'

export function routeOf(url: string): { name?: RouteName; def?: RouteDef } {
    const segment = new URL(url, ROUTE_BASE).pathname.split('/').find(Boolean) ?? ''
    if (!Object.hasOwn(ROUTES, segment)) return {}
    const name = segment as RouteName
    const def: RouteDef = ROUTES[name]
    return isBuilt(def) ? { name, def } : {}
}

export type WindowName = {
    [K in RouteName]: (typeof ROUTES)[K] extends { look: WindowLook } ? K : never
}[RouteName]

export const WINDOWS = Object.fromEntries(
    Object.entries(ROUTES).flatMap(([name, def]: [string, RouteDef]) =>
        def.look ? [[name, def.look]] : []
    )
) as Record<WindowName, WindowLook>
