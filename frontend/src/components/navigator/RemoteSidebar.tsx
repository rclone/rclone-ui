import { Button, ScrollShadow, Tooltip, cn } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'

import { StarIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useRemoteConfig } from '@/lib/hooks'
import rclone from '@/lib/rclone/client'
import type { AllowedKey, RemoteString } from './types'
import { getDiskIcon, getDiskLabel, shouldShowDisk } from './utils'
import { usePersistedStore } from '@/store'

function RemoteButton({
    remote,
    onSelect,
    isSelected,
}: {
    remote: string
    onSelect: (remote: string) => void
    isSelected: boolean
}) {
    const remoteConfigQuery = useRemoteConfig(remote)

    const info = remoteConfigQuery.data ?? null

    return (
        <Tooltip content={remote} placement="right" size="lg" color="foreground">
            <Button
                isIconOnly={true}
                size="lg"
                variant={isSelected ? 'faded' : 'light'}
                onPress={() => onSelect(remote)}
                className="shrink-0"
                // The icon says which backend, the tooltip which remote; without this the button
                // is announced as "drive" and every Google Drive remote sounds identical.
                aria-label={remote}
            >
                <img
                    src={`/icons/backends/${info?.type}.png`}
                    className="object-contain size-6"
                    alt={info?.type}
                />
            </Button>
        </Tooltip>
    )
}

export default function RemoteSidebar({
    position,
    selectedRemote,
    cwd,
    onRemoteSelect,
    allowedKeys,
    remotes,
}: {
    position: 'left' | 'right'
    selectedRemote: RemoteString
    cwd?: string
    onRemoteSelect: (remote: string | 'UI_LOCAL_FS' | 'UI_FAVORITES', initialPath?: string) => void
    allowedKeys: AllowedKey[]
    remotes: string[]
}) {
    const canShowFavorites = allowedKeys.includes('FAVORITES')
    const canShowLocal = allowedKeys.includes('LOCAL_FS')
    const canShowRemotes = allowedKeys.includes('REMOTES')

    const disksQuery = useQuery({
        queryKey: ['core', 'disks'],
        queryFn: () => rclone('/core/disks'),
        staleTime: 1000 * 60 * 5,
        enabled: canShowLocal,
    })

    // The Commander's bar (its shortcuts cog) lets the user leave disks and folders out.
    const hiddenLocalPaths = usePersistedStore((state) => state.hiddenLocalPaths)
    const disks = useMemo(
        () =>
            (disksQuery.data?.disks ?? []).filter(
                (disk) => shouldShowDisk(disk, allowedKeys) && !hiddenLocalPaths.includes(disk)
            ),
        [disksQuery.data, allowedKeys, hiddenLocalPaths]
    )

    const activeDisk = useMemo(() => {
        if (selectedRemote !== 'UI_LOCAL_FS' || !cwd) return null
        const sorted = [...disks].sort((a, b) => b.length - a.length)
        return sorted.find((disk) => cwd.startsWith(disk)) ?? null
    }, [selectedRemote, cwd, disks])

    const orderClass = position === 'right' ? 'order-last' : 'order-first'

    return (
        <nav
            aria-label="Places"
            className={cn('flex flex-col items-center w-20 h-full shrink-0', orderClass)}
        >
            <ScrollShadow
                className={cn(
                    'flex flex-col items-center w-full h-full gap-5 py-4 overflow-y-auto'
                )}
                size={69}
            >
                {canShowFavorites && (
                    <Tooltip
                        content="Favorites"
                        placement={position === 'left' ? 'right' : 'left'}
                        size="lg"
                        color="foreground"
                    >
                        <Button
                            isIconOnly={true}
                            className="shrink-0"
                            size="lg"
                            variant={selectedRemote === 'UI_FAVORITES' ? 'faded' : 'light'}
                            onPress={() => onRemoteSelect('UI_FAVORITES')}
                        >
                            <StarIcon className="stroke-warning fill-warning size-6" />
                        </Button>
                    </Tooltip>
                )}
                {canShowLocal &&
                    disks.map((disk) => {
                        const { icon: DiskIcon, className: iconColor } = getDiskIcon(disk)
                        const label = getDiskLabel(disk)
                        return (
                            <Tooltip
                                key={disk}
                                content={label}
                                placement={position === 'left' ? 'right' : 'left'}
                                color="foreground"
                                size="lg"
                            >
                                <Button
                                    isIconOnly={true}
                                    aria-label={label}
                                    className="shrink-0"
                                    size="lg"
                                    onPress={() => onRemoteSelect('UI_LOCAL_FS', disk)}
                                    variant={activeDisk === disk ? 'faded' : 'light'}
                                >
                                    <DiskIcon className={cn('size-6', iconColor)} />
                                </Button>
                            </Tooltip>
                        )
                    })}
                {canShowRemotes &&
                    remotes.map((remote) => (
                        <RemoteButton
                            remote={remote}
                            key={remote}
                            onSelect={() => onRemoteSelect(remote)}
                            isSelected={selectedRemote === remote}
                        />
                    ))}
            </ScrollShadow>
        </nav>
    )
}
