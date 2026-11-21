import { Button, cn, Skeleton } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    Envelope as EnvelopeIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
} from '@zappicon/react'
import { AnimatePresence, motion } from 'framer-motion'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { useNow } from '../../../lib/format'
import {
    NOTIFICATION_PROVIDERS,
    type NotificationCatalog,
    NotificationProvider,
    type NotificationTarget,
    providerMeta,
    useNotificationsCatalog,
    useNotificationTargets,
    useSmtp,
} from '../../../lib/notifications'
import { message } from '../../../lib/shell'
import EmptyState from '../../components/EmptyState'
import { ProviderTile } from '../../components/icons/ProviderIcon'
import { useRowMotion } from '../../components/list/ListWindow'
import { Panel, SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import SettingsWindow from '../../components/SettingsWindow'
import { WINDOWS } from '../../routes'
import NotificationTargetDrawer from './NotificationTargetDrawer'
import SmtpDrawer from './SmtpDrawer'
import TargetRow from './TargetRow'

const LOOK = WINDOWS.notifications

const EMPTY: NotificationTarget[] = []

/**
 * The Notifications window: the places that the app sends its notifications to, and the mail
 * server. With no place yet, it shows what notifications are for and the providers to start with.
 */
export default function Notifications() {
    // The core stores the targets and records the result of each delivery on its target.
    // notifications.changed brings the new lastSentAt and lastError here.
    const targetsQuery = useNotificationTargets()
    const catalogQuery = useNotificationsCatalog()
    const smtpQuery = useSmtp()
    const now = useNow()

    const catalog = catalogQuery.data

    const [addingProvider, setAddingProvider] = useState<NotificationProvider | null>(null)
    const [editingTarget, setEditingTarget] = useState<NotificationTarget | null>(null)
    const [smtpOpen, setSmtpOpen] = useState(false)

    const notificationTargets = targetsQuery.data ?? EMPTY

    const sortedTargets = useMemo(
        () => [...notificationTargets].sort((a, b) => b.createdAt - a.createdAt),
        [notificationTargets]
    )

    // Email goes out through the mail server. Without one, the email targets say so.
    const mailMissing = !smtpQuery.isLoading && !smtpQuery.data?.host

    const drawerProvider = editingTarget?.provider ?? addingProvider

    // The form of a target is built from the catalog. If the catalog failed to load, pressing a
    // card shows an error, rather than opening nothing (or opening late, after a Retry).
    const whenCatalogLoaded = async (open: () => void) => {
        if (catalogQuery.isError) {
            const reason = formatErrorMessage(catalogQuery.error)
            await message(t`The notification events couldn't be loaded. ${reason}`, {
                title: t`Notifications`,
                kind: 'error',
            })
            return
        }
        open()
    }

    const handleAddPress = async (provider: NotificationProvider) => {
        await whenCatalogLoaded(() => setAddingProvider(provider))
    }

    const listId = useId()
    const addId = useId()
    const rowMotion = useRowMotion()

    let content: ReactNode
    if (targetsQuery.isError) {
        content = (
            <EmptyState
                icon={LOOK.icon}
                tone={LOOK.tone}
                title={t`Couldn't load the notifications`}
                description={formatErrorMessage(targetsQuery.error)}
                className="min-h-[50vh] py-10"
                actions={
                    <Button
                        variant="flat"
                        isLoading={targetsQuery.isFetching}
                        onPress={() => targetsQuery.refetch()}
                    >
                        <Trans>Retry</Trans>
                    </Button>
                }
            />
        )
    } else if (targetsQuery.isLoading) {
        content = <TargetsSkeleton />
    } else if (sortedTargets.length === 0) {
        content = <FirstRun catalog={catalog} onAdd={handleAddPress} />
    } else {
        content = (
            <>
                <section aria-labelledby={listId} className="flex flex-col gap-3">
                    <SectionTitle
                        id={listId}
                        title={t({
                            message: 'Sending to',
                            comment: 'Title of the list of places that notifications are sent to.',
                        })}
                        description={summaryOf(sortedTargets, mailMissing)}
                    />
                    <Panel className="overflow-hidden @container">
                        <ul
                            aria-label={t`Notifications`}
                            className="flex flex-col divide-y divide-divider"
                        >
                            <AnimatePresence initial={false}>
                                {sortedTargets.map((target) => (
                                    <motion.li
                                        key={target.id}
                                        {...rowMotion}
                                        className="overflow-hidden"
                                    >
                                        <TargetRow
                                            target={target}
                                            catalog={catalog}
                                            now={now}
                                            mailMissing={mailMissing}
                                            onEdit={() =>
                                                whenCatalogLoaded(() => setEditingTarget(target))
                                            }
                                            onMailServer={() => setSmtpOpen(true)}
                                        />
                                    </motion.li>
                                ))}
                            </AnimatePresence>
                        </ul>
                    </Panel>
                </section>

                <section aria-labelledby={addId} className="flex flex-col gap-3">
                    <SectionTitle
                        id={addId}
                        title={t`Add another`}
                        description={t`Send to one more place. You choose its events next.`}
                    />
                    <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-5">
                        {NOTIFICATION_PROVIDERS.map((provider) => (
                            <ProviderButton
                                key={provider}
                                provider={provider}
                                onPress={() => handleAddPress(provider)}
                            />
                        ))}
                    </div>
                </section>
            </>
        )
    }

    return (
        <SettingsWindow
            look={LOOK}
            description={t`Get a message when a transfer fails or finishes, a mount or serve stops, or an update is out.`}
            actions={
                <Button
                    variant="flat"
                    startContent={<EnvelopeIcon className="size-4" />}
                    onPress={() => setSmtpOpen(true)}
                    aria-label={t`Mail server`}
                    data-focus-visible="false"
                >
                    <Trans>Mail server</Trans>
                </Button>
            }
            className="flex flex-col gap-8 @container"
        >
            {catalogQuery.isError && (
                <div
                    role="alert"
                    className="flex items-center gap-3 py-3 pl-4 pr-3 rounded-2xl bg-danger/10 text-danger-600 dark:text-danger-500"
                >
                    <ExclamationTriangleIcon className="size-5 shrink-0" />
                    <p className="flex-1 leading-snug text-small text-pretty">
                        <Trans>
                            The notification events couldn't be loaded, so targets can't be added or
                            edited.
                        </Trans>{' '}
                        {formatErrorMessage(catalogQuery.error)}
                    </p>
                    <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        className="shrink-0"
                        isLoading={catalogQuery.isFetching}
                        onPress={() => catalogQuery.refetch()}
                        data-focus-visible="false"
                    >
                        <Trans>Retry</Trans>
                    </Button>
                </div>
            )}

            {content}

            {!!drawerProvider && !!catalog && (
                <NotificationTargetDrawer
                    key={editingTarget?.id ?? addingProvider ?? 'closed'}
                    isOpen={true}
                    onClose={() => {
                        setAddingProvider(null)
                        setEditingTarget(null)
                    }}
                    provider={drawerProvider}
                    target={editingTarget ?? undefined}
                    catalog={catalog}
                />
            )}
            <SmtpDrawer isOpen={smtpOpen} onClose={() => setSmtpOpen(false)} />
        </SettingsWindow>
    )
}

function summaryOf(targets: NotificationTarget[], mailMissing: boolean): string {
    const on = targets.filter((target) => target.isEnabled)
    const failing = on.filter(
        (target) =>
            !!target.lastError ||
            (mailMissing && target.provider === NotificationProvider.NotificationProviderEmail)
    ).length
    const count = onCount(on.length, targets.length)
    if (failing === 0) return count
    const attention = plural(failing, {
        one: '# needs attention.',
        other: '# need attention.',
    })
    return t({
        message: `${count} ${attention}`,
        comment: 'Two sentences about the list: "All 3 are on. 1 needs attention."',
    })
}

function onCount(on: number, total: number): string {
    if (on === total) {
        return plural(total, { one: 'It is on.', other: 'All # are on.' })
    }
    return plural(on, { one: `# of ${total} is on.`, other: `# of ${total} are on.` })
}

const CARD = cn(
    SURFACE,
    SURFACE_HOVER,
    'outline-none text-left',
    'transition-[translate,scale,box-shadow] duration-150 ease-out',
    'hover:-translate-y-0.5 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-primary',
    'motion-reduce:transition-none motion-reduce:hover:translate-y-0'
)

/** A provider in "Add another". */
function ProviderButton({
    provider,
    onPress,
}: {
    provider: NotificationProvider
    onPress: () => void
}) {
    const meta = providerMeta(provider)
    return (
        <button
            type="button"
            onClick={onPress}
            data-provider={provider}
            aria-label={meta.addLabel}
            className={cn(CARD, 'flex items-center gap-2.5 py-2.5 pl-2.5 pr-3')}
        >
            <ProviderTile provider={provider} size="md" />
            <span className="flex-1 min-w-0 font-medium truncate text-small">{meta.label}</span>
        </button>
    )
}

/** A provider in the first-run state. */
function ProviderCard({
    provider,
    onPress,
    className,
}: {
    provider: NotificationProvider
    onPress: () => void
    className?: string
}) {
    const meta = providerMeta(provider)
    return (
        <button
            type="button"
            onClick={onPress}
            data-provider={provider}
            className={cn(CARD, 'flex flex-col items-start gap-3 p-4', className)}
        >
            <ProviderTile provider={provider} size="xl" />
            <span className="flex flex-col min-w-0 gap-0.5">
                <span className="font-semibold leading-snug text-[15px]">{meta.label}</span>
                <span className="text-xs leading-snug text-default-500 text-pretty">
                    {meta.description}
                </span>
            </span>
        </button>
    )
}

const SEVERITY_DOT: Record<string, StatusKind> = {
    error: 'danger',
    success: 'success',
    info: 'idle',
}

/** The window's content before any target is added. */
function FirstRun({
    catalog,
    onAdd,
}: {
    catalog: NotificationCatalog | undefined
    onAdd: (provider: NotificationProvider) => void
}) {
    const pickId = useId()
    const eventsId = useId()
    return (
        <>
            <section aria-labelledby={pickId} className="flex flex-col gap-3">
                <SectionTitle
                    id={pickId}
                    title={t`Where should notifications go?`}
                    description={t`Pick a place to start. Next you choose which events it hears about, and send a test.`}
                />
                <div className="grid grid-cols-1 gap-3 @lg:grid-cols-6">
                    {NOTIFICATION_PROVIDERS.map((provider, i) => (
                        <ProviderCard
                            key={provider}
                            provider={provider}
                            onPress={() => onAdd(provider)}
                            // Three chat apps on the first row, a webhook and email on the second.
                            className={i < 3 ? '@lg:col-span-2' : '@lg:col-span-3'}
                        />
                    ))}
                </div>
            </section>

            {catalog && (
                <section aria-labelledby={eventsId} className="flex flex-col gap-3">
                    <SectionTitle
                        id={eventsId}
                        title={t`What they tell you about`}
                        description={t`Each place gets the events you pick for it. You can change them any time.`}
                    />
                    <Panel className="grid grid-cols-1 gap-5 p-5 @lg:grid-cols-3">
                        {catalog.categories.map((category) => (
                            <div key={category.id} className="flex flex-col gap-2">
                                <p className="font-medium text-small text-default-600">
                                    {category.label}
                                </p>
                                <ul className="flex flex-col gap-1.5">
                                    {catalog.events
                                        .filter((event) => event.category === category.id)
                                        .map((event) => (
                                            <li
                                                key={event.id}
                                                className="flex items-center gap-2 text-small"
                                                title={event.description}
                                            >
                                                <StatusDot
                                                    kind={SEVERITY_DOT[event.severity] ?? 'idle'}
                                                />
                                                {event.label}
                                            </li>
                                        ))}
                                </ul>
                            </div>
                        ))}
                    </Panel>
                </section>
            )}
        </>
    )
}

function TargetsSkeleton() {
    return (
        <div aria-busy={true} aria-label={t`Loading`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
                <Skeleton className="w-24 h-4 rounded-md" />
                <Skeleton className="h-3.5 rounded-md w-56" />
            </div>
            <Panel className="flex flex-col divide-y divide-divider">
                {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="flex items-center gap-3.5 py-4 pl-4 pr-3">
                        <Skeleton className="size-9 rounded-[10px]" />
                        <div className="flex flex-col flex-1 gap-2">
                            <Skeleton className="w-40 h-4 rounded-md" />
                            <Skeleton className="w-64 h-3 rounded-md" />
                        </div>
                        <Skeleton className="w-24 h-4 rounded-md" />
                        <Skeleton className="w-10 h-6 rounded-full" />
                    </div>
                ))}
            </Panel>
        </div>
    )
}
