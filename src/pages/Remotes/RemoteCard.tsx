import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownSection,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    Folder as FolderIcon,
    HardDrive as HardDriveIcon,
    MoreHorizontalCircle as MoreIcon,
    Pen as PenIcon,
    PlugSimple as PlugSimpleIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import type { ReactNode } from 'react'
import { formatErrorMessage, reportError } from '../../../lib/errors'
import { reconnectRemote } from '../../../lib/reconnect'
import type { HealthResult } from '../../../lib/remotes'
import { message, openWindow, platform } from '../../../lib/shell'
import { BackendTile, backendLabel } from '../../components/BackendIcon'
import { SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { ToneProgress } from '../../components/look/ToneProgress'
import type { Tone } from '../../components/look/tones'
import { formatSize, NEARLY_FULL, spaceFree, usageOf } from './usage'

export const CARD_HEIGHT = 76

function openFor(route: string) {
    openWindow(route).catch((error: unknown) => reportError(error, { title: t`Window not opened` }))
}

export function browse(remote: string) {
    openFor(`/commander?path=${encodeURIComponent(`${remote}:`)}`)
}

export function mount(remote: string) {
    openFor(`/mount?initialSource=${encodeURIComponent(`${remote}:`)}`)
}

export async function reconnect(remote: string) {
    try {
        if ((await reconnectRemote(remote)) === 'done') {
            await message(t`Remote "${remote}" has been reconnected successfully.`, {
                title: t({
                    message: 'Reconnected',
                    comment: 'Title: a remote was signed in again.',
                }),
                kind: 'info',
            })
        }
    } catch (error) {
        await message(formatErrorMessage(error, t`Reconnection failed`), {
            title: t`Reconnect Error`,
            kind: 'error',
        })
    }
}

export function RemoteCard({
    remote,
    type,
    health,
    tone,
    onEdit,
    onDelete,
}: {
    remote: string
    type: string | undefined
    health: HealthResult | undefined
    /** The remote's color in the storage bar. */
    tone: Tone | undefined
    onEdit: () => void
    onDelete: () => void
}) {
    const expired = health?.state === 'faulty' && !!health.canReconnect
    const actionsLabel = t`Actions for ${remote}`

    return (
        <div
            data-remote={remote}
            className={cn(
                'group relative flex items-center gap-3.5 pl-3.5 pr-2.5',
                SURFACE,
                SURFACE_HOVER,
                'transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-0.5',
                'has-[[data-press]:active]:scale-[0.985] motion-reduce:transition-none motion-reduce:hover:translate-y-0'
            )}
            style={{ height: CARD_HEIGHT }}
        >
            <BackendTile type={type} alt={backendLabel(type)} size="xl" />
            <div className="flex flex-col flex-1 min-w-0 gap-1">
                {/* The name stretches over the card, so the whole card edits the remote. */}
                <button
                    type="button"
                    data-press={true}
                    onClick={onEdit}
                    className="text-left outline-none text-[15px] font-semibold leading-tight truncate after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-primary"
                >
                    {remote}
                </button>
                <RemoteStatus type={type} health={health} />
            </div>

            <div className="relative z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
                <QuickAction label={t`Browse in Commander`} onPress={() => browse(remote)}>
                    <FolderIcon className="size-4" />
                </QuickAction>
                <QuickAction label={MOUNT} onPress={() => mount(remote)}>
                    <HardDriveIcon className="size-4" />
                </QuickAction>
            </div>

            {expired ? (
                <Button
                    size="sm"
                    color="warning"
                    variant="flat"
                    startContent={<PlugSimpleIcon className="size-4" />}
                    onPress={() => reconnect(remote)}
                    className="relative z-10 shrink-0"
                >
                    {RECONNECT}
                </Button>
            ) : (
                <StorageMeter remote={remote} health={health} tone={tone} />
            )}

            <div className="relative z-10 shrink-0">
                <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                    <DropdownTrigger>
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            radius="full"
                            aria-label={actionsLabel}
                            className="text-default-500 data-[hover=true]:text-foreground"
                        >
                            <MoreIcon className="size-5" />
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label={actionsLabel}
                        onAction={(key) => {
                            if (key === 'config') onEdit()
                            else if (key === 'browse') browse(remote)
                            else if (key === 'mount') mount(remote)
                            else if (key === 'reconnect') reconnect(remote)
                            else if (key === 'delete') onDelete()
                        }}
                    >
                        <DropdownSection showDivider={true}>
                            <DropdownItem
                                key="browse"
                                startContent={<FolderIcon className="size-4" />}
                            >
                                <Trans>Browse in Commander</Trans>
                            </DropdownItem>
                            <DropdownItem
                                key="mount"
                                startContent={<HardDriveIcon className="size-4" />}
                            >
                                {MOUNT}
                            </DropdownItem>
                        </DropdownSection>
                        <DropdownSection showDivider={true}>
                            <DropdownItem
                                key="config"
                                startContent={<PenIcon className="size-4" />}
                            >
                                {t({
                                    message: 'Edit',
                                    comment:
                                        'Menu item: opens the item (a remote, a schedule…) to change it.',
                                })}
                            </DropdownItem>
                            <DropdownItem
                                key="reconnect"
                                startContent={<PlugSimpleIcon className="size-4" />}
                            >
                                {RECONNECT}
                            </DropdownItem>
                        </DropdownSection>
                        <DropdownSection>
                            <DropdownItem
                                key="delete"
                                color="danger"
                                className="text-danger"
                                startContent={<TrashIcon className="size-4" />}
                            >
                                {t({
                                    message: 'Delete',
                                    comment: 'Menu item: deletes the remote, after a question.',
                                })}
                            </DropdownItem>
                        </DropdownSection>
                    </DropdownMenu>
                </Dropdown>
            </div>
        </div>
    )
}

const MOUNT = t({
    message: 'Mount',
    comment: "Button: opens the Mount window with the remote's root as the source.",
})

const RECONNECT = t({
    message: 'Reconnect',
    comment: 'Button: signs a remote in again after its sign-in expired.',
})

function QuickAction({
    label,
    onPress,
    children,
}: {
    label: string
    onPress: () => void
    children: ReactNode
}) {
    return (
        <Tooltip content={label} color="foreground" delay={400} closeDelay={0}>
            <Button
                isIconOnly={true}
                size="sm"
                variant="flat"
                aria-label={label}
                onPress={onPress}
                className="text-default-600 data-[hover=true]:text-foreground"
            >
                {children}
            </Button>
        </Tooltip>
    )
}

function RemoteStatus({
    type,
    health,
}: {
    type: string | undefined
    health: HealthResult | undefined
}) {
    const status = healthStatus(health)
    return (
        <p className="flex items-center min-w-0 gap-1.5 text-xs leading-tight text-default-500">
            {type && <span className="shrink-0">{backendLabel(type)}</span>}
            {type && status && <span aria-hidden={true}>·</span>}
            {status && (
                <span
                    className={cn(
                        'flex items-center min-w-0 gap-1.5',
                        status.kind === 'danger' && 'text-danger',
                        status.kind === 'warning' && 'text-warning-600 dark:text-warning',
                        // Over the card's press area, so the full error shows on hover.
                        status.detail && 'relative z-10'
                    )}
                    title={status.detail}
                >
                    <StatusDot kind={status.kind} />
                    <span className="truncate">
                        {status.label}
                        {status.detail && `: ${status.detail}`}
                    </span>
                </span>
            )}
        </p>
    )
}

/** What a remote's last check found, in words. `detail` is the core's error message. */
export function healthStatus(
    health: HealthResult | undefined
): { kind: StatusKind; label: string; detail?: string } | undefined {
    switch (health?.state) {
        case 'ok':
            return {
                kind: 'success',
                label: t({ message: 'Connected', comment: 'State of a remote.' }),
            }
        case 'checking':
            return {
                kind: 'active',
                label: t({
                    message: 'Checking',
                    comment: 'State of a remote: it is being checked.',
                }),
            }
        case 'unknown':
            return {
                kind: 'warning',
                label: t({
                    message: 'No answer',
                    comment: 'State of a remote: its check got no answer.',
                }),
            }
        case 'faulty':
            return health.canReconnect
                ? { kind: 'danger', label: t`Sign-in expired` }
                : {
                      kind: 'danger',
                      label: t({ message: 'Can’t connect', comment: 'State of a remote.' }),
                      detail: health.error,
                  }
        default:
            return undefined
    }
}

/** Keeps its width when it has nothing to show, so the cards' columns line up. */
function StorageMeter({
    remote,
    health,
    tone,
}: {
    remote: string
    health: HealthResult | undefined
    tone: Tone | undefined
}) {
    const usage = usageOf(health)
    const box = 'flex flex-col justify-center w-40 gap-1.5 shrink-0 tabular-nums text-xs'

    if (health?.state === 'checking') {
        return (
            <div aria-hidden={true} className={box}>
                <span className="w-16 h-2.5 rounded-full bg-default-200/80 animate-pulse motion-reduce:animate-none" />
                <span className="h-1.5 rounded-full bg-default-200/80 animate-pulse motion-reduce:animate-none" />
            </div>
        )
    }
    if (!usage || usage.used === undefined) return <div aria-hidden={true} className={box} />

    const used = formatSize(usage.used)
    if (usage.ratio === undefined) {
        return (
            <div className={box}>
                <Trans comment='How much a remote stores, on two lines: "12 GB" and "used, no size limit given".'>
                    <span className="font-medium text-foreground">{used}</span>
                    <span className="text-default-500">used, no size limit given</span>
                </Trans>
            </div>
        )
    }

    const full = usage.ratio >= NEARLY_FULL
    const total = formatSize(usage.total ?? 0)
    const free = formatSize(usage.free ?? 0)
    return (
        <div className={box}>
            <span className="flex items-baseline justify-between gap-2">
                <Trans comment='How much a remote stores, at the two ends of a line: "1.2 GB" and "of 15 GB".'>
                    <span className="font-medium text-foreground">{used}</span>
                    <span className="text-default-500">of {total}</span>
                </Trans>
            </span>
            <ToneProgress
                tone={full ? 'red' : (tone ?? 'blue')}
                value={usage.ratio}
                label={t`Storage used on ${remote}`}
            />
            <span className={cn(full ? 'text-danger' : 'text-default-500')}>
                {full
                    ? t({
                          message: `Almost full, ${free} free`,
                          comment: 'The space left on a remote that is nearly full.',
                      })
                    : spaceFree(free)}
            </span>
        </div>
    )
}

export function RemoteCardSkeleton() {
    return (
        <div
            aria-hidden={true}
            className={cn('flex items-center gap-3.5 px-3.5', SURFACE)}
            style={{ height: CARD_HEIGHT }}
        >
            <span className="size-12 rounded-[14px] bg-default-200/70 animate-pulse motion-reduce:animate-none" />
            <span className="flex flex-col flex-1 gap-2">
                <span className="w-32 h-3 rounded-full bg-default-200/70 animate-pulse motion-reduce:animate-none" />
                <span className="w-48 h-2.5 rounded-full bg-default-200/60 animate-pulse motion-reduce:animate-none" />
            </span>
            <span className="flex flex-col w-40 gap-2">
                <span className="w-20 h-2.5 rounded-full bg-default-200/60 animate-pulse motion-reduce:animate-none" />
                <span className="h-1.5 rounded-full bg-default-200/60 animate-pulse motion-reduce:animate-none" />
            </span>
        </div>
    )
}
