import {
    Button,
    Card,
    CardBody,
    Chip,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Switch,
    Tooltip,
    cn,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import { PencilIcon, SendIcon, SettingsIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
    FREE_MAX_TARGETS,
    NOTIFICATION_PROVIDERS,
    maskWebhookUrl,
    removeNotificationTarget,
    sendTestNotification,
    updateNotificationTarget,
    useNotificationTargets,
    useNotificationsCatalog,
} from '../../../lib/notifications'
import { usePersistedStore } from '../../../store/persisted'
import type {
    NotificationCatalog,
    NotificationProvider,
    NotificationTarget,
} from '../../../types/notifications'
import NotificationTargetDrawer from '../../components/NotificationTargetDrawer'
import ProviderIcon, { TelegramIcon, WhatsAppIcon } from '../../components/icons/ProviderIcon'
import BaseSection from './BaseSection'

const PROVIDER_ORDER: NotificationProvider[] = ['discord', 'slack', 'telegram', 'webhook']

export default function NotificationsSection() {
    // Targets live in a Rust-owned store (notifications/targets.json) shared with the headless
    // runner — polled so runner-recorded lastSentAt/lastError show up here.
    const targetsQuery = useNotificationTargets()
    const catalogQuery = useNotificationsCatalog()
    const licenseValid = usePersistedStore((state) => state.licenseValid)

    const [addingProvider, setAddingProvider] = useState<NotificationProvider | null>(null)
    const [editingTarget, setEditingTarget] = useState<NotificationTarget | null>(null)

    const notificationTargets = targetsQuery.data ?? []

    const sortedTargets = useMemo(
        () => [...notificationTargets].sort((a, b) => b.createdAt - a.createdAt),
        [notificationTargets]
    )

    const drawerProvider = editingTarget?.provider ?? addingProvider

    const handleAddPress = async (provider: NotificationProvider) => {
        // Creation-time gate only — the launch reconcile (lib/notifications.ts) is what
        // disables over-limit targets when a license lapses.
        if (!licenseValid && notificationTargets.length >= FREE_MAX_TARGETS) {
            await message(
                `Community version does not support more than ${FREE_MAX_TARGETS} notification webhooks. Activate a license for unlimited webhooks.`,
                {
                    title: 'Missing license',
                    kind: 'error',
                }
            )
            return
        }
        setAddingProvider(provider)
    }

    return (
        <BaseSection
            header={{
                title: 'Notifications',
            }}
        >
            <div className="flex flex-col gap-6 px-4 pb-10">
                <section className="flex flex-col gap-4">
                    <p className="text-sm font-semibold uppercase text-default-500">Add New</p>
                    <div className="grid grid-cols-2 gap-2.5">
                        {PROVIDER_ORDER.map((provider) => (
                            <ProviderCard
                                key={provider}
                                provider={provider}
                                onPress={() => handleAddPress(provider)}
                            />
                        ))}
                        <DummyProviderCard
                            label="Telegram (botless)"
                            description="Get messages without your own bot"
                            icon={<TelegramIcon className="text-sky-500 size-8 shrink-0" />}
                            onPress={() =>
                                message(
                                    'Telegram without your own bot is coming in v4. Upgrade to v4 to use it.',
                                    { title: 'Coming in v4', kind: 'info' }
                                )
                            }
                        />
                        <DummyProviderCard
                            label="WhatsApp"
                            description="Get messages on WhatsApp"
                            icon={<WhatsAppIcon className="text-green-500 size-8 shrink-0" />}
                            onPress={() =>
                                message(
                                    'WhatsApp notifications are coming in v4. Upgrade to v4 to use them.',
                                    { title: 'Coming in v4', kind: 'info' }
                                )
                            }
                        />
                    </div>
                </section>

                <section className="flex flex-col gap-2.5">
                    {sortedTargets.map((target) => (
                        <NotificationTargetCard
                            key={target.id}
                            target={target}
                            catalog={catalogQuery.data}
                            onEdit={() => setEditingTarget(target)}
                        />
                    ))}
                    {sortedTargets.length === 0 && !targetsQuery.isLoading && (
                        <p className="py-10 text-sm text-center text-default-500">
                            No notification webhooks configured yet. Pick a provider above to add
                            one.
                        </p>
                    )}
                </section>
            </div>
            {!!drawerProvider && !!catalogQuery.data && (
                <NotificationTargetDrawer
                    key={editingTarget?.id ?? addingProvider ?? 'closed'}
                    isOpen={true}
                    onClose={() => {
                        setAddingProvider(null)
                        setEditingTarget(null)
                    }}
                    provider={drawerProvider}
                    target={editingTarget ?? undefined}
                    catalog={catalogQuery.data}
                    existingTargets={notificationTargets}
                />
            )}
        </BaseSection>
    )
}

function ProviderCard({
    provider,
    onPress,
}: {
    provider: NotificationProvider
    onPress: () => void
}) {
    const providerMeta = NOTIFICATION_PROVIDERS[provider]

    return (
        <Card
            shadow="sm"
            isPressable={true}
            onPress={onPress}
            className="h-24 bg-content2"
            data-focus-visible="false"
            data-provider={provider}
        >
            <CardBody className="relative flex flex-row items-center gap-3 px-4">
                <ProviderIcon
                    provider={provider}
                    className={cn('size-8 shrink-0', providerMeta.accentClass)}
                />
                <div className="flex flex-col gap-0.5 text-left">
                    <p className="font-medium">{providerMeta.label}</p>
                    <p className="text-small text-default-500">{providerMeta.description}</p>
                </div>
            </CardBody>
        </Card>
    )
}

// Placeholder cards for providers that don't exist yet — tapping explains they're coming in v4.
function DummyProviderCard({
    label,
    description,
    icon,
    onPress,
}: {
    label: string
    description: string
    icon: ReactNode
    onPress: () => void
}) {
    return (
        <Card
            shadow="sm"
            isPressable={true}
            onPress={onPress}
            className="h-24 bg-content2"
            data-focus-visible="false"
        >
            <CardBody className="relative flex flex-row items-center gap-3 px-4">
                {icon}
                <div className="flex flex-col gap-0.5 text-left">
                    <div className="flex items-center gap-2">
                        <p className="font-medium">{label}</p>
                    </div>
                    <p className="text-small text-default-500">{description}</p>
                </div>
            </CardBody>
        </Card>
    )
}

function NotificationTargetCard({
    target,
    catalog,
    onEdit,
}: {
    target: NotificationTarget
    catalog: NotificationCatalog | undefined
    onEdit: () => void
}) {
    const providerMeta = NOTIFICATION_PROVIDERS[target.provider]
    const queryClient = useQueryClient()
    const invalidateTargets = () =>
        queryClient.invalidateQueries({ queryKey: ['notifications', 'targets'] })

    const eventsLabel = useMemo(
        () =>
            catalog && target.events.length === catalog.events.length
                ? 'All events'
                : `${target.events.length} ${target.events.length === 1 ? 'event' : 'events'}`,
        [target.events, catalog]
    )

    const sendTestMutation = useMutation({
        mutationFn: async () => {
            await sendTestNotification(target)
        },
        onSuccess: async () => {
            await message('Test notification sent successfully.', {
                title: target.name,
                kind: 'info',
            })
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Test failed',
                kind: 'error',
            })
        },
        // Success or failure, Rust recorded lastSentAt/lastError — refresh the warning chip.
        onSettled: invalidateTargets,
    })

    const toggleMutation = useMutation({
        mutationFn: async (isEnabled: boolean) => {
            await updateNotificationTarget(target.id, { isEnabled })
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Update failed',
                kind: 'error',
            })
        },
        onSettled: invalidateTargets,
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            await removeNotificationTarget(target.id)
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Delete failed',
                kind: 'error',
            })
        },
        onSettled: invalidateTargets,
    })

    const handleDelete = async () => {
        const confirmation = await ask(
            `Are you sure you want to remove ${target.name}? This action cannot be reverted.`,
            {
                title: `Removing ${target.name}`,
                kind: 'warning',
            }
        )

        if (!confirmation) {
            return
        }

        deleteMutation.mutate()
    }

    return (
        <Card
            shadow="sm"
            isBlurred={true}
            className="h-20 border-[0.5px] dark:border-none border-divider bg-content3/50 dark:bg-content2/90"
            isPressable={true}
            onPress={onEdit}
            data-focus-visible="false"
        >
            <CardBody className={cn(!target.isEnabled && 'opacity-60')}>
                <div className="flex items-center justify-between h-full">
                    <div className="flex items-center gap-4">
                        <ProviderIcon
                            provider={target.provider}
                            className={cn('ml-2 size-8 shrink-0', providerMeta.accentClass)}
                        />
                        <div className="flex flex-col gap-0.5 text-left">
                            <p className="font-light text-large">{target.name}</p>
                            <p className="font-mono text-small text-default-500">
                                {maskWebhookUrl(target.url)}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center justify-end gap-4">
                        {!!target.lastError && (
                            <Tooltip
                                content={`Last delivery failed: ${target.lastError}`}
                                color="warning"
                                size="lg"
                            >
                                <TriangleAlertIcon className="size-5 text-warning" />
                            </Tooltip>
                        )}
                        <Chip size="sm" radius="sm" variant="flat">
                            {eventsLabel}
                        </Chip>
                        <Switch
                            size="sm"
                            color="primary"
                            isSelected={target.isEnabled}
                            onValueChange={(isEnabled) => toggleMutation.mutate(isEnabled)}
                            aria-label={`Enable ${target.name}`}
                            data-focus-visible="false"
                        />
                        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                            <DropdownTrigger>
                                <Button
                                    type="button"
                                    color="default"
                                    isIconOnly={true}
                                    radius="full"
                                    variant="light"
                                >
                                    <SettingsIcon className="opacity-50 size-8 hover:opacity-100" />
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                                onAction={async (key) => {
                                    const keyAsString = key as string

                                    if (keyAsString === 'edit') {
                                        onEdit()
                                    } else if (keyAsString === 'test') {
                                        sendTestMutation.mutate()
                                    } else if (keyAsString === 'delete') {
                                        await handleDelete()
                                    }
                                }}
                            >
                                <DropdownItem
                                    startContent={<PencilIcon className="w-4 h-4" />}
                                    key="edit"
                                >
                                    Edit
                                </DropdownItem>
                                <DropdownItem
                                    startContent={<SendIcon className="w-4 h-4" />}
                                    key="test"
                                >
                                    Send Test
                                </DropdownItem>
                                <DropdownItem
                                    startContent={<Trash2Icon className="w-4 h-4" />}
                                    key="delete"
                                    color="danger"
                                >
                                    Delete
                                </DropdownItem>
                            </DropdownMenu>
                        </Dropdown>
                    </div>
                </div>
            </CardBody>
        </Card>
    )
}
