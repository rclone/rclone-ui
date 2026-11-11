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
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import {
    Check as CheckIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    MoreHorizontalCircle as MoreHorizontalCircleIcon,
    Pen as PenIcon,
    SendAlt as SendAltIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { timeAgo } from '../../../lib/format'
import {
    type NotificationCatalog,
    NotificationProvider,
    type NotificationTarget,
    providerMeta,
    removeNotificationTarget,
    sendTestNotification,
    setNotificationTargetEnabled,
} from '../../../lib/notifications'
import { ask, message, platform } from '../../../lib/shell'
import { ProviderTile } from '../../components/icons/ProviderIcon'
import { ROW_LINE_1, ROW_LINE_2, RowStatus } from '../../components/list/ListWindow'
import type { StatusKind } from '../../components/look/Status'

function statusOf(
    target: NotificationTarget,
    now: number,
    mailMissing: boolean
): { kind: StatusKind; label: string; detail: string } {
    const when = target.lastSentAt ? timeAgo(target.lastSentAt, now) : ''
    if (!target.isEnabled) {
        return {
            kind: 'idle',
            label: t({
                message: 'Off',
                context: 'state of a notification target',
                comment: 'State of a notification target that is turned off.',
            }),
            detail: when
                ? t({ message: `Last sent ${when}`, comment: 'Such as "Last sent 5 minutes ago".' })
                : t`Sends nothing`,
        }
    }
    if (mailMissing && target.provider === NotificationProvider.NotificationProviderEmail) {
        return { kind: 'warning', label: t`No mail server`, detail: t`Email can't go out yet` }
    }
    if (target.lastError) {
        return { kind: 'danger', label: t`Last delivery failed`, detail: when }
    }
    if (target.lastSentAt) {
        return {
            kind: 'success',
            label: t({ message: 'Delivered', comment: 'State: the last notification arrived.' }),
            detail: when,
        }
    }
    return { kind: 'idle', label: t`Not sent yet`, detail: t`Send a test to check it` }
}

function firstLine(text: string): string {
    return text.split('\n')[0] ?? text
}

/**
 * One place that notifications go, as a row. Pressing the row edits the target. A failed
 * delivery's error, or the missing mail server, shows under the row. Send test shows while the
 * pointer or the focus is on the row.
 */
export default function TargetRow({
    target,
    catalog,
    now,
    mailMissing,
    onEdit,
    onMailServer,
}: {
    target: NotificationTarget
    catalog: NotificationCatalog | undefined
    now: number
    mailMissing: boolean
    onEdit: () => void
    onMailServer: () => void
}) {
    const meta = providerMeta(target.provider)
    const switchLabel = useId()
    const statusId = useId()

    const eventsLabel = useMemo(
        () =>
            catalog && target.events.length === catalog.events.length
                ? t`All events`
                : plural(target.events.length, { one: '# event', other: '# events' }),
        [target.events, catalog]
    )

    // A test that went through says so on its button for a moment.
    const [sent, setSent] = useState(false)
    useEffect(() => {
        if (!sent) return
        const id = setTimeout(() => setSent(false), 2000)
        return () => clearTimeout(id)
    }, [sent])

    const sendTestMutation = useMutation({
        mutationFn: async () => {
            await sendTestNotification({ id: target.id })
        },
        onSuccess: () => setSent(true),
        onError: async (error) => {
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Test failed`,
                kind: 'error',
            })
        },
    })

    const toggleMutation = useMutation({
        mutationFn: async (isEnabled: boolean) => {
            await setNotificationTargetEnabled(target.id, isEnabled)
        },
        onError: async (error) => {
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Update failed`,
                kind: 'error',
            })
        },
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            await removeNotificationTarget(target.id)
        },
        onError: async (error) => {
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Delete failed`,
                kind: 'error',
            })
        },
    })

    const name = target.name

    const handleDelete = async () => {
        const confirmation = await ask(t`Delete ${name}? This can't be undone.`, {
            title: t`Delete ${name}`,
            kind: 'warning',
            destructive: true,
            okLabel: t({ message: 'Delete', comment: 'Button: deletes the notification.' }),
        })

        if (!confirmation) {
            return
        }

        deleteMutation.mutate()
    }

    const status = statusOf(target, now, mailMissing)
    const off = !target.isEnabled
    const testing = sendTestMutation.isPending
    const noMail =
        !off && mailMissing && target.provider === NotificationProvider.NotificationProviderEmail

    return (
        <div className="flex flex-col gap-2.5 py-3 pl-3 pr-3 transition-colors duration-150 ease-out group/row hover:bg-default-100/50 dark:hover:bg-white/[0.025]">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onEdit}
                    aria-label={t`Edit ${name}`}
                    aria-describedby={statusId}
                    data-provider={target.provider}
                    className="flex items-center flex-1 min-w-0 gap-3.5 p-1 text-left outline-none rounded-xl focus-visible:ring-2 focus-visible:ring-primary"
                >
                    <ProviderTile
                        provider={target.provider}
                        size="lg"
                        className={cn(
                            'transition-[opacity,filter] duration-200 ease-out',
                            off && 'opacity-40 grayscale'
                        )}
                    />
                    <span className="flex flex-col flex-1 min-w-0 gap-0.5">
                        <span
                            className={cn(
                                'font-semibold text-[15px]',
                                ROW_LINE_1,
                                off && 'text-default-500'
                            )}
                        >
                            {target.name}
                        </span>
                        <span className={ROW_LINE_2}>
                            {meta.label}
                            <span aria-hidden={true} className="mx-1.5 text-default-300">
                                ·
                            </span>
                            {eventsLabel}
                        </span>
                    </span>
                    <RowStatus
                        id={statusId}
                        kind={status.kind}
                        label={status.label}
                        when={status.detail}
                    />
                </button>

                <div className="flex items-center gap-0.5 shrink-0">
                    <Tooltip
                        content={
                            sent
                                ? t({ message: 'Sent', comment: 'A test notification was sent.' })
                                : t`Send test`
                        }
                        color="foreground"
                    >
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            aria-label={t`Send a test to ${name}`}
                            isLoading={testing}
                            onPress={() => sendTestMutation.mutate()}
                            className={cn(
                                'text-default-600 transition-opacity duration-150 ease-out motion-reduce:transition-none',
                                testing || sent
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100'
                            )}
                        >
                            {sent ? (
                                <CheckIcon className="size-4 text-success" />
                            ) : (
                                <SendAltIcon className="size-4" />
                            )}
                        </Button>
                    </Tooltip>
                    <span role="status" className="sr-only">
                        {sent ? t`Test sent to ${name}` : ''}
                    </span>
                    {/* HeroUI's Switch drops its aria-label when it has no text, so the switch is
                        named by a hidden label instead. */}
                    <span id={switchLabel} className="sr-only">
                        <Trans>Enable {name}</Trans>
                    </span>
                    <Switch
                        size="sm"
                        color="primary"
                        isSelected={target.isEnabled}
                        onValueChange={(isEnabled) => toggleMutation.mutate(isEnabled)}
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
                                aria-label={t`More for ${name}`}
                                className="text-default-600"
                            >
                                <MoreHorizontalCircleIcon className="size-4" />
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label={t`Actions for ${name}`}
                            onAction={async (key) => {
                                if (key === 'edit') {
                                    onEdit()
                                } else if (key === 'test') {
                                    sendTestMutation.mutate()
                                } else if (key === 'delete') {
                                    await handleDelete()
                                }
                            }}
                        >
                            <DropdownItem key="edit" startContent={<PenIcon className="size-4" />}>
                                <Trans>Edit</Trans>
                            </DropdownItem>
                            <DropdownItem
                                key="test"
                                startContent={<SendAltIcon className="size-4" />}
                            >
                                <Trans>Send test</Trans>
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

            {noMail ? (
                <RowNote tone="warning">
                    <span className="flex-1 min-w-0">
                        <Trans>
                            Email goes out through your mail server, which isn't set up yet.
                        </Trans>
                    </span>
                    <Button
                        size="sm"
                        variant="flat"
                        color="warning"
                        className="h-7 shrink-0"
                        onPress={onMailServer}
                        data-focus-visible="false"
                    >
                        <Trans>Set up mail server</Trans>
                    </Button>
                </RowNote>
            ) : (
                !off &&
                !!target.lastError && (
                    <Tooltip
                        content={<span className="whitespace-pre-wrap">{target.lastError}</span>}
                        color="foreground"
                        className="max-w-md"
                        delay={300}
                    >
                        <div>
                            <RowNote tone="danger">
                                <span className="flex-1 min-w-0 truncate">
                                    {firstLine(target.lastError)}
                                </span>
                            </RowNote>
                        </div>
                    </Tooltip>
                )
            )}
        </div>
    )
}

/** A line under a row about what needs attention, lined up with the row's name. */
function RowNote({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
    return (
        <div
            className={cn(
                'flex items-center gap-2 min-h-9 py-1 pl-3 pr-1.5 ml-[3.375rem] rounded-xl text-small',
                tone === 'danger'
                    ? 'bg-danger/10 text-danger-600 dark:text-danger-500'
                    : 'bg-warning/10 text-warning-700 dark:text-warning-500'
            )}
        >
            <ExclamationTriangleIcon className="size-4 shrink-0" />
            {children}
        </div>
    )
}
