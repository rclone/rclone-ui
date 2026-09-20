import { Tooltip, cn } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactElement, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import rclone from '@/lib/rclone/client'
import { usePersistedStore } from '@/store'
import {
    REMOTES_SHOWN,
    allRemotesLeaf,
    type NavLeaf,
    type NavZone,
    SETTINGS_ZONE,
    ZONES,
    isCurrent,
    remoteLeaf,
} from './nav'

// One row recipe for every entry: 30px tall (never squeezed by a short screen: the list scrolls),
// 13px medium, ring on keyboard focus only. Collapsed,
// a row is its icon alone, centred in the 32px rail, and its label moves into a tooltip.
const ROW =
    'flex items-center shrink-0 h-[30px] gap-2.5 px-2.5 rounded-lg text-[13px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const ROW_IDLE = 'text-default-500 hover:bg-foreground/[0.06] hover:text-foreground'
const ROW_ACTIVE = 'bg-primary/20 text-foreground'
const ROW_COLLAPSED = 'justify-center w-[30px] px-0 mx-auto'

function LeafIcon({ leaf, active }: { leaf: NavLeaf; active: boolean }) {
    if (leaf.tile !== undefined) {
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'flex items-center justify-center w-4 h-4 rounded-[4px] text-[10px] font-semibold leading-none shrink-0',
                    active ? 'bg-primary-300 text-black' : 'bg-foreground/10 text-default-600'
                )}
            >
                {leaf.tile}
            </span>
        )
    }
    const Icon = leaf.icon
    if (!Icon) return null
    return (
        <Icon className={cn('w-4 h-4 shrink-0', active && 'text-primary-300')} strokeWidth={1.75} />
    )
}

function RailTooltip({ content, children }: { content: string; children: ReactElement }) {
    return (
        <Tooltip
            content={content}
            placement="right"
            delay={0}
            closeDelay={0}
            offset={10}
            color="foreground"
            classNames={{ content: 'max-w-56' }}
        >
            {children}
        </Tooltip>
    )
}

function NavRow({ leaf, collapsed }: { leaf: NavLeaf; collapsed: boolean }) {
    const location = useLocation()
    const active = !leaf.plain && isCurrent(leaf.to, location)
    const title = leaf.count !== undefined ? `${leaf.label} · ${leaf.count}` : leaf.label
    const row = (
        <Link
            to={leaf.to}
            aria-label={collapsed ? title : undefined}
            aria-current={active ? 'page' : undefined}
            className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE, collapsed && ROW_COLLAPSED)}
        >
            <LeafIcon leaf={leaf} active={active} />
            {!collapsed && <span className="truncate">{leaf.label}</span>}
            {!collapsed && leaf.count !== undefined && (
                <span className="ml-auto text-[11px] tabular-nums text-default-400">
                    {leaf.count}
                </span>
            )}
        </Link>
    )
    return collapsed ? <RailTooltip content={title}>{row}</RailTooltip> : row
}

function ZoneLabel({
    label,
    collapsed,
    first = false,
}: {
    label: string
    collapsed: boolean
    first?: boolean
}) {
    if (collapsed) {
        return first ? null : (
            <div className="h-px mx-2 my-2 shrink-0 bg-divider" aria-hidden="true" />
        )
    }
    return (
        <div
            className={cn(
                'flex items-end shrink-0 h-6 px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-default-400',
                !first && 'mt-3'
            )}
        >
            {label}
        </div>
    )
}

function Zone({
    zone,
    collapsed,
    first = false,
}: {
    zone: NavZone
    collapsed: boolean
    first?: boolean
}) {
    return (
        <>
            <ZoneLabel label={zone.label} collapsed={collapsed} first={first} />
            {zone.items.map((leaf) => (
                <NavRow key={leaf.to} leaf={leaf} collapsed={collapsed} />
            ))}
        </>
    )
}

export default function Sidebar({ collapsed }: { collapsed: boolean }) {
    const remotes = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })
    const remoteNames: string[] = remotes.data ?? []
    // Newest first: rclone lists alphabetically, so the host store remembers when each remote
    // was first listed. Not yet noted means new, so it leads until the effect below records it.
    const firstSeen = usePersistedStore((state) => state.remoteFirstSeen)
    const noteRemotes = usePersistedStore((state) => state.noteRemotes)
    useEffect(() => {
        if (remotes.data) noteRemotes(remotes.data)
    }, [remotes.data, noteRemotes])
    const shown = useMemo(
        () =>
            [...remoteNames]
                .sort(
                    (a, b) =>
                        (firstSeen[b] ?? Number.POSITIVE_INFINITY) -
                            (firstSeen[a] ?? Number.POSITIVE_INFINITY) || a.localeCompare(b)
                )
                .slice(0, REMOTES_SHOWN),
        [remoteNames, firstSeen]
    )

    return (
        <nav
            aria-label="Sidebar"
            data-state={collapsed ? 'collapsed' : 'expanded'}
            className={cn(
                'flex flex-col h-full px-3 pt-3 pb-3 shrink-0 bg-neutral-100 select-none transition-[width] duration-200 ease-out dark:bg-black',
                collapsed ? 'w-14' : 'w-64'
            )}
        >
            <div className="flex flex-col flex-1 min-h-0 gap-0.5 overflow-x-hidden overflow-y-auto">
                {ZONES.map((zone, index) => (
                    <Zone key={zone.label} zone={zone} collapsed={collapsed} first={index === 0} />
                ))}
                <Zone
                    zone={{
                        label: 'Remotes',
                        items: [...shown.map(remoteLeaf), allRemotesLeaf(remoteNames.length)],
                    }}
                    collapsed={collapsed}
                />
                <Zone zone={SETTINGS_ZONE} collapsed={collapsed} />
            </div>
        </nav>
    )
}
