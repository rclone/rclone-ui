import { cn, ScrollShadow, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Star as StarIcon } from '@zappicon/react'
import { type ReactNode, useMemo } from 'react'
import { configNameOf } from '../../../lib/paths'
import { usePref } from '../../../lib/prefs'
import { useRemoteHealth, useRemotes } from '../../../lib/remotes'
import { platform } from '../../../lib/shell'
import BackendIcon from '../BackendIcon'
import { IconTile } from '../look/IconTile'
import type { AllowedKey, RemoteString } from './types'
import useDisks from './useDisks'
import { getDiskIcon, getDiskLabel, isInLocalFolder, shouldShowDisk } from './utils'

/**
 * A place in the sidebar: its tile, in a square that lights up when the panel is there. A bar on
 * the side of the panel marks the place shown, so the two sidebars read as two separate panels.
 */
function Place({
    label,
    hint,
    position,
    isSelected,
    onPress,
    children,
}: {
    label: string
    /** A second line in the tooltip, such as a remote that stopped working. */
    hint?: ReactNode
    position: 'left' | 'right'
    isSelected: boolean
    onPress: () => void
    children: ReactNode
}) {
    return (
        <Tooltip
            content={
                hint ? (
                    <span className="flex flex-col py-0.5">
                        <span className="font-medium">{label}</span>
                        {hint}
                    </span>
                ) : (
                    label
                )
            }
            placement={position === 'left' ? 'right' : 'left'}
            size="sm"
            closeDelay={0}
            delay={250}
        >
            <button
                type="button"
                aria-label={label}
                aria-current={isSelected ? 'true' : undefined}
                onClick={onPress}
                className={cn(
                    'relative grid shrink-0 size-10 place-items-center rounded-xl outline-none',
                    'transition-[background-color,scale] duration-150 ease-out active:scale-[0.94] motion-reduce:active:scale-100',
                    'focus-visible:ring-2 focus-visible:ring-primary',
                    isSelected
                        ? 'bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_3px_rgb(0_0_0/0.1)] dark:bg-white/12 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08)]'
                        : 'hover:bg-black/5 dark:hover:bg-white/8'
                )}
            >
                {children}
                {isSelected && (
                    <span
                        aria-hidden={true}
                        className={cn(
                            'absolute top-1/2 -translate-y-1/2 w-1 h-5 rounded-full bg-primary',
                            position === 'left' ? '-right-1' : '-left-1'
                        )}
                    />
                )}
            </button>
        </Tooltip>
    )
}

/** A short line between the groups of places. */
function GroupRule() {
    return <span aria-hidden={true} className="w-5 h-px my-1 shrink-0 bg-divider" />
}

function RemotePlace({
    remote,
    position,
    onSelect,
    isSelected,
    isFaulty,
}: {
    remote: string
    position: 'left' | 'right'
    onSelect: (remote: string) => void
    isSelected: boolean
    isFaulty: boolean
}) {
    // The backend's type is already in the shared remotes list, so there is nothing to fetch.
    const type = useRemotes().remotes.find((candidate) => candidate.name === remote)?.type

    return (
        // The icon shows the backend and the label shows the remote. Without the label, screen
        // readers announce the button as "drive", and every Google Drive remote sounds the same.
        <Place
            label={remote}
            hint={
                isFaulty ? (
                    <span className="text-danger-300 dark:text-danger-500">
                        <Trans>Not responding</Trans>
                    </span>
                ) : undefined
            }
            position={position}
            isSelected={isSelected}
            onPress={() => onSelect(remote)}
        >
            <span className="relative grid size-7 place-items-center rounded-lg bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.08)] dark:bg-zinc-800 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]">
                <BackendIcon type={type} alt={type} className="size-[18px]" />
                {isFaulty && (
                    <span
                        aria-hidden={true}
                        className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-danger ring-2 ring-background"
                    />
                )}
            </span>
        </Place>
    )
}

/**
 * A panel's places: the favorites, the disks and folders of this computer, and the remotes, each
 * as a tile. It sits on the window beside its panel, on the panel's outer side.
 */
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

    const allDisks = useDisks(canShowLocal)

    // The Commander's bar (its shortcuts cog) lets the user hide disks and folders.
    const [hiddenLocalPaths] = usePref('hiddenLocalPaths')
    const disks = useMemo(
        () =>
            (allDisks ?? []).filter(
                (disk) => shouldShowDisk(disk, allowedKeys) && !hiddenLocalPaths.includes(disk)
            ),
        [allDisks, allowedKeys, hiddenLocalPaths]
    )

    const activeDisk = useMemo(() => {
        if (selectedRemote !== 'UI_LOCAL_FS' || !cwd) return null
        const sorted = [...disks].sort((a, b) => b.length - a.length)
        return sorted.find((disk) => isInLocalFolder(cwd, disk)) ?? null
    }, [selectedRemote, cwd, disks])

    // A remote that stopped answering is marked, so a failing listing has an explanation in view.
    const health = useRemoteHealth().data
    const showsDisks = canShowLocal && disks.length > 0
    const showsRemotes = canShowRemotes && remotes.length > 0

    return (
        <nav
            aria-label={t`Places`}
            className={cn(
                'flex flex-col items-center w-12 h-full shrink-0',
                position === 'right' ? 'order-last' : 'order-first'
            )}
        >
            <ScrollShadow
                className={cn(
                    'flex flex-col items-center w-full h-full gap-1 pb-3 overflow-y-auto',
                    // On macOS the window's buttons sit in the top left corner, over the content.
                    platform() === 'macos' ? 'pt-9' : 'pt-0.5'
                )}
                size={40}
            >
                {canShowFavorites && (
                    <Place
                        label={t`Favorites`}
                        position={position}
                        isSelected={selectedRemote === 'UI_FAVORITES'}
                        onPress={() => onRemoteSelect('UI_FAVORITES')}
                    >
                        <IconTile icon={StarIcon} tone="orange" size="md" />
                    </Place>
                )}
                {canShowFavorites && (showsDisks || showsRemotes) && <GroupRule />}
                {showsDisks &&
                    disks.map((disk) => {
                        const { icon, tone } = getDiskIcon(disk)
                        return (
                            <Place
                                key={disk}
                                label={getDiskLabel(disk)}
                                position={position}
                                isSelected={activeDisk === disk}
                                onPress={() => onRemoteSelect('UI_LOCAL_FS', disk)}
                            >
                                <IconTile icon={icon} tone={tone} size="md" />
                            </Place>
                        )
                    })}
                {showsDisks && showsRemotes && <GroupRule />}
                {showsRemotes &&
                    remotes.map((remote) => (
                        <RemotePlace
                            remote={remote}
                            key={remote}
                            position={position}
                            onSelect={() => onRemoteSelect(remote)}
                            isSelected={!!selectedRemote && configNameOf(selectedRemote) === remote}
                            isFaulty={health?.[remote]?.state === 'faulty'}
                        />
                    ))}
            </ScrollShadow>
        </nav>
    )
}
