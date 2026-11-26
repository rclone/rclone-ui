import { cn, ScrollShadow, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Star as StarIcon } from '@zappicon/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../../../lib/format'
import { configNameOf } from '../../../lib/paths'
import { usePref } from '../../../lib/prefs'
import { type HealthResult, useRemoteHealth, useRemotes } from '../../../lib/remotes'
import { platform } from '../../../lib/shell'
import BackendIcon from '../BackendIcon'
import { IconTile } from '../look/IconTile'
import { TIP } from '../look/tip'
import { usePeek } from './peek'
import type { AllowedKey, RemoteString } from './types'
import useDisks from './useDisks'
import { getDiskIcon, getDiskLabel, isInLocalFolder, shouldShowDisk } from './utils'

function Place({
    label,
    hint,
    peekHint,
    peeks = true,
    position,
    isSelected,
    onPress,
    children,
}: {
    label: string
    hint?: ReactNode
    peekHint?: ReactNode
    peeks?: boolean
    position: 'left' | 'right'
    isSelected: boolean
    onPress: () => void
    children: ReactNode
}) {
    const button = useRef<HTMLButtonElement>(null)
    const [hovered, setHovered] = useState(false)
    const peek = usePeek()
    const [peeked, setPeeked] = useState(false)
    useEffect(() => {
        const own = button.current?.getBoundingClientRect()
        const clip = button.current?.closest('[data-peek-clip]')?.getBoundingClientRect()
        setPeeked(
            peeks && peek && !!own && (!clip || (own.top >= clip.top && own.bottom <= clip.bottom))
        )
    }, [peek, peeks])

    return (
        <Tooltip
            isOpen={hovered || peeked}
            onOpenChange={setHovered}
            content={
                peeked && (hint || peekHint) ? (
                    <span className="flex items-baseline gap-2">
                        <span className="font-medium">{label}</span>
                        {hint}
                        {peekHint && <span className="opacity-70">{peekHint}</span>}
                    </span>
                ) : hint ? (
                    <span className="flex flex-col py-0.5">
                        <span className="font-medium">{label}</span>
                        {hint}
                    </span>
                ) : (
                    label
                )
            }
            placement={position === 'left' ? 'right' : 'left'}
            {...TIP}
            closeDelay={0}
            delay={250}
        >
            <button
                ref={button}
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

function spaceWords(health: HealthResult | undefined): string | undefined {
    const about = health?.state === 'ok' ? health.about : undefined
    if (typeof about?.free !== 'number') return undefined
    const bytes =
        typeof about.total === 'number'
            ? about.total
            : typeof about.used === 'number'
              ? about.used + about.free
              : undefined
    if (bytes === undefined) {
        const size = formatBytes(about.free)
        return t({
            message: `${size} free`,
            comment: 'The space left on a remote: "12.5 GB free".',
        })
    }
    const free = formatBytes(about.free)
    const total = formatBytes(bytes)
    return t({
        message: `${free} free of ${total}`,
        comment: 'The space left on a remote and its size: "120 GB free of 2 TB".',
    })
}

function GroupRule() {
    return <span aria-hidden={true} className="w-5 h-px my-1 shrink-0 bg-divider" />
}

function RemotePlace({
    remote,
    position,
    onSelect,
    isSelected,
    isFaulty,
    space,
}: {
    remote: string
    position: 'left' | 'right'
    onSelect: (remote: string) => void
    isSelected: boolean
    isFaulty: boolean
    space?: string
}) {
    const type = useRemotes().remotes.find((candidate) => candidate.name === remote)?.type

    return (
        <Place
            label={remote}
            hint={
                isFaulty ? (
                    <span className="text-danger-300 dark:text-danger-500">
                        <Trans>Not responding</Trans>
                    </span>
                ) : undefined
            }
            peekHint={space}
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
                data-peek-clip={true}
                className={cn(
                    'flex flex-col items-center w-full h-full gap-1 pb-3 overflow-y-auto',
                    platform() === 'macos' ? 'pt-9' : 'pt-0.5'
                )}
                size={40}
            >
                {canShowFavorites && (
                    <Place
                        label={t`Favorites`}
                        peeks={false}
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
                            space={spaceWords(health?.[remote])}
                        />
                    ))}
            </ScrollShadow>
        </nav>
    )
}
