import type { LucideIcon } from 'lucide-react'
import {
    ActivityIcon,
    ArrowLeftRightIcon,
    ClockIcon,
    CopyIcon,
    DownloadIcon,
    FlameIcon,
    FolderTreeIcon,
    FoldersIcon,
    HardDriveIcon,
    LayoutDashboardIcon,
    ListIcon,
    MoveIcon,
    RefreshCwIcon,
    ServerIcon,
    Trash2Icon,
    WandSparklesIcon,
} from 'lucide-react'
import { SETTINGS_SECTIONS, type SectionKey, isSectionKey } from '../../pages/Settings/sections'

// The browser sidebar's model: labelled zones of links. Remotes is a zone built at runtime from
// the daemon's remote list; Settings lists its sections directly.
export interface NavLeaf {
    to: string
    label: string
    icon?: LucideIcon
    /** A one-letter tile instead of an icon (remotes have no icon of their own). */
    tile?: string
    /** Why the entry is unavailable on the current host, when it is. */
    /** A figure after the label (how many remotes the full list holds). */
    count?: number
    /** Only a link: never drawn as the current page (a remote opens the Commander, whose own row lights up). */
    plain?: boolean
}

export interface NavZone {
    label: string
    items: NavLeaf[]
}

export const ZONES: NavZone[] = [
    {
        label: 'Overview',
        items: [
            { to: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
            { to: '/wizard', label: 'Wizard', icon: WandSparklesIcon },
            { to: '/commander', label: 'Commander', icon: FolderTreeIcon },
            { to: '/transfers', label: 'Transfers', icon: ActivityIcon },
            { to: '/schedules', label: 'Schedules', icon: ClockIcon },
            { to: '/templates', label: 'Templates', icon: FoldersIcon },
        ],
    },
    {
        label: 'Operations',
        items: [
            { to: '/copy', label: 'Copy', icon: CopyIcon },
            { to: '/move', label: 'Move', icon: MoveIcon },
            { to: '/sync', label: 'Sync', icon: RefreshCwIcon },
            { to: '/bisync', label: 'Bisync', icon: ArrowLeftRightIcon },
            { to: '/download', label: 'Download', icon: DownloadIcon },
            { to: '/mount', label: 'Mount', icon: HardDriveIcon },
            { to: '/serve', label: 'Serve', icon: ServerIcon },
            { to: '/delete', label: 'Delete', icon: Trash2Icon },
            { to: '/purge', label: 'Purge', icon: FlameIcon },
        ],
    },
]

function settingsLeaf(key: SectionKey): NavLeaf {
    const section = SETTINGS_SECTIONS[key]
    return {
        to: `/settings/${key}`,
        label: section.label,
        icon: section.icon,
    }
}

// Only these sections are listed; Remotes has its own zone and route.
const SETTINGS_KEYS: SectionKey[] = ['notifications', 'smtp', 'rclone', 'team']

export const SETTINGS_ZONE: NavZone = { label: 'Settings', items: SETTINGS_KEYS.map(settingsLeaf) }

/** How many remotes the sidebar lists before pointing at the full page. */
export const REMOTES_SHOWN = 5

/** The way to every remote; carries the total once the sidebar is not showing them all. */
export function allRemotesLeaf(total: number): NavLeaf {
    return {
        to: '/remotes',
        label: 'All remotes',
        icon: ListIcon,
        count: total > REMOTES_SHOWN ? total : undefined,
    }
}

/** A remote opens in the Commander's right panel, the same link the Dashboard's remote rows use. */
export function remoteLeaf(name: string): NavLeaf {
    return {
        to: `/commander?path=${encodeURIComponent(`${name}:`)}`,
        label: name,
        tile: name[0]?.toUpperCase() ?? '#',
        plain: true,
    }
}

interface Where {
    pathname: string
    search: string
}

/** Exact match on the path, and on the query when the entry carries one. */
export function isCurrent(to: string, where: Where): boolean {
    const [path, search = ''] = to.split('?')
    return where.pathname === path && (search === '' || where.search === `?${search}`)
}

/** The header's trail: the zone that owns the route, then the page. */
export function breadcrumbFor(where: Where): string[] {
    const { pathname, search } = where
    if (pathname === '/settings' || pathname.startsWith('/settings/')) {
        const key = pathname.slice('/settings/'.length)
        const section = isSectionKey(key) ? SETTINGS_SECTIONS[key] : SETTINGS_SECTIONS.rclone
        return ['Settings', section.label]
    }
    if (pathname === '/remotes') return ['Remotes']
    if (pathname === '/commander') {
        const target = new URLSearchParams(search).get('path')
        return target ? ['Commander', target] : ['Commander']
    }
    for (const zone of ZONES) {
        const item = zone.items.find((entry) => entry.to === pathname)
        if (item) return zone.label === 'Overview' ? [item.label] : [zone.label, item.label]
    }
    return []
}
