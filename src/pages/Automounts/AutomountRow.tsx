import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Switch,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    MoreVerticalCircle as MoreVerticalCircleIcon,
    Pen as PenIcon,
    Play as PlayIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { useId } from 'react'
import type { Mounts } from '../../../lib/core/types'
import { platform } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { StatusDot } from '../../components/look/Status'
import { TONE_TEXT } from '../../components/look/tones'
import { WINDOWS } from '../../routes'
import { sourceOf } from './source'
import { canMountNow, statusOf } from './status'

export interface RowActions {
    onToggle: (enabled: boolean) => void
    onMountNow: () => void
    onEdit: () => void
    onDelete: () => void
}

/** A row stands for a mount, so it has the Mount window's tile. */
const LOOK = WINDOWS.mount

/**
 * One automount, as a row of the list. "Mount now" shows under the status while the automount is
 * on and not mounted. Edit shows while the pointer or the focus is on the row.
 */
export default function AutomountRow({
    automount: a,
    mounting,
    actions,
}: {
    automount: Mounts.AutomountRow
    /** Whether "Mount now" is waiting for the mount to start. */
    mounting: boolean
    actions: RowActions
}) {
    const source = sourceOf(a)
    const status = statusOf(a)
    const switchLabel = useId()

    const statusCell = (
        <div className="flex flex-col min-w-0 gap-0.5">
            <span className="flex items-center gap-2 font-medium leading-snug text-small">
                <StatusDot kind={status.kind} />
                {status.label}
            </span>
            {canMountNow(a) ? (
                <Button
                    size="sm"
                    variant="flat"
                    aria-label={t`Mount ${source} now`}
                    isLoading={mounting}
                    startContent={
                        mounting ? undefined : (
                            <PlayIcon
                                variant="filled"
                                className={cn('size-3', TONE_TEXT[LOOK.tone])}
                            />
                        )
                    }
                    onPress={actions.onMountNow}
                    className="self-start h-6 gap-1.5 px-2 mt-1 ml-4 font-medium text-tiny min-w-0 rounded-md"
                >
                    <Trans>Mount now</Trans>
                </Button>
            ) : (
                <span className="pl-4 text-xs leading-snug text-default-500">
                    {a.remoteMissing
                        ? t`Not in your remotes`
                        : a.enabled
                          ? t`Mounts when Rclone UI starts`
                          : t({ message: 'Off', context: 'state of an automount' })}
                </span>
            )}
        </div>
    )

    return (
        <div className="flex items-center gap-3.5 py-3.5 pl-4 pr-3 group/row">
            <IconTile
                icon={LOOK.icon}
                tone={LOOK.tone}
                size="lg"
                className={cn(
                    'transition-[opacity,filter] duration-200 ease-out',
                    !a.enabled && 'opacity-40 grayscale'
                )}
            />
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <span className="leading-snug truncate text-[15px]" title={source}>
                    <span className={cn('font-semibold', !a.enabled && 'text-default-500')}>
                        {a.remote}
                    </span>
                    <span className="text-default-500">
                        {a.remotePath ? `:${a.remotePath}` : ':'}
                    </span>
                </span>
                <span
                    className="flex items-center min-w-0 gap-1 font-mono text-xs text-default-500"
                    title={a.mountPoint}
                >
                    <ArrowRightSmallIcon className="size-3.5 shrink-0 text-default-400" />
                    <span className="sr-only">
                        <Trans>Mount point:</Trans>{' '}
                    </span>
                    <span className="truncate">{a.mountPoint}</span>
                </span>
                {/* In a narrow window, the status goes under the mount point. */}
                <div className="mt-1 @2xl:hidden">{statusCell}</div>
            </div>
            <div className="hidden w-52 shrink-0 @2xl:block">{statusCell}</div>
            <div className="flex items-center gap-0.5 shrink-0">
                <Tooltip content={t`Edit`} color="foreground">
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        aria-label={t`Edit the automount of ${source}`}
                        onPress={actions.onEdit}
                        className="opacity-0 text-default-600 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none"
                    >
                        <PenIcon className="size-4" />
                    </Button>
                </Tooltip>
                {/* HeroUI's Switch drops its aria-label when it has no text, so the switch is
                named by a hidden label instead. */}
                <span id={switchLabel} className="sr-only">
                    {a.enabled
                        ? t`Turn off the automount of ${source}`
                        : t`Turn on the automount of ${source}`}
                </span>
                <Switch
                    size="sm"
                    isSelected={a.enabled}
                    onValueChange={actions.onToggle}
                    aria-labelledby={switchLabel}
                    data-focus-visible="false"
                    classNames={{ base: 'mx-1.5', wrapper: 'me-0' }}
                />
                <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                    <DropdownTrigger>
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            aria-label={t`More for ${source}`}
                            className="text-default-600"
                        >
                            <MoreVerticalCircleIcon className="size-4" />
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label={t`Actions for ${source}`}
                        onAction={(key) => {
                            if (key === 'edit') actions.onEdit()
                            if (key === 'delete') actions.onDelete()
                        }}
                    >
                        <DropdownItem key="edit" startContent={<PenIcon className="size-4" />}>
                            <Trans>Edit</Trans>
                        </DropdownItem>
                        <DropdownItem
                            key="delete"
                            color="danger"
                            className="text-danger"
                            startContent={<TrashIcon className="size-4" />}
                        >
                            <Trans>Delete</Trans>
                        </DropdownItem>
                    </DropdownMenu>
                </Dropdown>
            </div>
        </div>
    )
}
