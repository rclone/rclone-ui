import { Button, Chip, cn, Link, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    CloudArrowUp as CloudArrowUpIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Folder as FolderIcon,
} from '@zappicon/react'
import { useId, useState } from 'react'
import type { Mounts } from '../../../lib/core/types'
import { formatErrorMessage } from '../../../lib/errors'
import {
    cannotMount,
    discardStopped,
    explainMountSupport,
    installWinFsp,
    mountAgain,
    stopMount,
    useMountSupport,
    useMounts,
    useStoppedMounts,
} from '../../../lib/mounts'
import { ask, message, openUrl, platform, revealPath } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { toastSuccess } from '../../components/toast'
import { WINDOWS } from '../../routes'

// The parts of the Mount page that show next to its form: the running mounts, the stopped mounts
// that still have uploads waiting, and a notice for a computer that can't mount.

type State = { label: string; kind: StatusKind }

const STARTING: State = { label: t`Starting`, kind: 'active' }

const STATE: Record<string, State> = {
    starting: STARTING,
    running: { label: t`Mounted`, kind: 'success' },
    restarting: { label: t`Restarting`, kind: 'warning' },
    failed: { label: t`Failed`, kind: 'danger' },
    stopped: { label: t`Stopped`, kind: 'idle' },
}

/** Returns how a mount's state is shown. An unknown state is shown as starting. */
function stateOf(state: string): State {
    return STATE[state] ?? STARTING
}

export function Notice({
    kind,
    role,
    children,
    className,
}: {
    kind: 'warning' | 'danger'
    role?: 'note' | 'alert'
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            role={role}
            className={cn(
                'flex items-start gap-3 px-4 py-3.5 rounded-2xl text-small',
                kind === 'warning'
                    ? 'bg-warning-50 shadow-[0_0_0_1px_hsl(var(--heroui-warning-200))] dark:bg-warning-50/15 dark:shadow-[0_0_0_1px_rgb(245_165_36/0.25)]'
                    : 'bg-danger-50 shadow-[0_0_0_1px_hsl(var(--heroui-danger-200))] dark:bg-danger-50/15 dark:shadow-[0_0_0_1px_rgb(243_18_96/0.3)]',
                className
            )}
        >
            {children}
        </div>
    )
}

function uploading(count: number): string {
    return t`${count} uploading`
}

/** What a stopped mount left behind. The count is unknown (negative) when it couldn't be read. */
function waitingToUpload(pending: number): string {
    if (pending < 0) return t`Files waiting to upload`
    return plural(pending, { one: '# file waiting to upload', other: '# files waiting to upload' })
}

function neverUploaded(pending: number, source: string): string {
    if (pending < 0) {
        return t`Files will never be uploaded to ${source}. Their copies in the cache are deleted.`
    }
    return plural(pending, {
        one: `# file will never be uploaded to ${source}. Its copy in the cache is deleted.`,
        other: `# files will never be uploaded to ${source}. Their copies in the cache are deleted.`,
    })
}

async function said(title: string, error: unknown) {
    await message(formatErrorMessage(error), { title, kind: 'error' })
}

/**
 * On a computer that can't mount, says why before the user tries. It offers to install WinFsp
 * when the app has the installer, and otherwise links to the download or the docs.
 */
export function MountSupportNotice() {
    const support = useMountSupport()
    const [installing, setInstalling] = useState(false)
    if (!support || support.supported) return null
    const docs = support.docs
    let action: { label: string; run: () => Promise<unknown> } | null = null
    if (support.canInstall) {
        action = {
            label: installing ? t`Installing WinFsp…` : t`Install WinFsp`,
            run: async () => {
                setInstalling(true)
                try {
                    await installWinFsp()
                } finally {
                    setInstalling(false)
                }
            },
        }
    } else if (docs) {
        action = {
            label: platform() === 'windows' ? t`Download WinFsp` : t`Read how to set it up`,
            run: () => openUrl(docs),
        }
    }
    return (
        <Notice kind="warning" role="note">
            <ExclamationTriangleIcon className="size-5 mt-px shrink-0 text-warning" />
            <span className="leading-relaxed text-pretty">
                <span className="font-medium">
                    <Trans>This computer cannot mount.</Trans>
                </span>{' '}
                {support.reason}
                {action ? (
                    <>
                        {' '}
                        <Link
                            as="button"
                            type="button"
                            size="sm"
                            underline="always"
                            isDisabled={installing}
                            onPress={() => {
                                action
                                    .run()
                                    .catch((error: unknown) =>
                                        console.error('[Mount] could not set up mounting', error)
                                    )
                            }}
                            className="align-baseline"
                        >
                            {action.label}
                        </Link>
                    </>
                ) : null}
            </span>
        </Notice>
    )
}

function RestartChip() {
    return (
        <Tooltip
            content={t`A remote it mounts changed: unmount and mount it again for the change to apply.`}
            placement="top"
            className="max-w-xs"
        >
            <Chip size="sm" variant="flat" color="warning" className="shrink-0">
                <Trans>Restart to apply</Trans>
            </Chip>
        </Tooltip>
    )
}

function LoadFailedNotice({
    title,
    error,
    retrying,
    onRetry,
}: {
    title: string
    error: unknown
    retrying: boolean
    onRetry: () => void
}) {
    return (
        <Notice kind="danger" role="alert" className="items-center">
            <ExclamationTriangleIcon className="size-5 shrink-0 text-danger" />
            <div className="flex flex-col flex-1 min-w-0">
                <span className="font-medium">{title}</span>
                <span className="text-tiny text-default-500">{formatErrorMessage(error)}</span>
            </div>
            <Button
                size="sm"
                variant="flat"
                isLoading={retrying}
                onPress={onRetry}
                data-focus-visible="false"
            >
                <Trans>Retry</Trans>
            </Button>
        </Notice>
    )
}

export function MountList() {
    const { mounts, query } = useMounts()
    const [stopping, setStopping] = useState<string | null>(null)
    const titleId = useId()
    // The error is shown above the last list that loaded, if there is one.
    const error = query.isError ? (
        <LoadFailedNotice
            title={t`Couldn't load the mounts`}
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => query.refetch()}
        />
    ) : null
    if (mounts.length === 0) return error
    const unmount = async (mount: Mounts.MountRow) => {
        setStopping(mount.id)
        try {
            await stopMount(mount.id)
            const place = mount.mountPoint
            toastSuccess(t`Unmounted ${place}`)
        } catch (error) {
            await said(t`Unmount`, error)
        } finally {
            setStopping(null)
        }
    }
    return (
        <section aria-label={t`Mounts`} className="flex flex-col gap-3">
            <SectionTitle
                id={titleId}
                className="px-1"
                title={
                    <span className="flex items-center gap-2">
                        <Trans>Mounted now</Trans>
                        <Chip
                            size="sm"
                            variant="flat"
                            classNames={{
                                base: 'h-5 px-0.5',
                                content: 'px-1 font-semibold tabular-nums text-tiny',
                            }}
                        >
                            {mounts.length}
                        </Chip>
                    </span>
                }
            />
            {error}
            <ul
                aria-labelledby={titleId}
                className={cn(SURFACE, 'flex flex-col divide-y divide-divider')}
            >
                {mounts.map((mount) => {
                    const state = stateOf(mount.state)
                    return (
                        <li
                            key={mount.id}
                            aria-label={mount.mountPoint}
                            className="flex items-center gap-3.5 px-4 py-3"
                        >
                            <IconTile
                                icon={WINDOWS.mount.icon}
                                tone={WINDOWS.mount.tone}
                                size="lg"
                            />
                            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                <div className="flex items-center min-w-0 gap-2">
                                    <span className="font-medium truncate">{mount.source}</span>
                                    {mount.restart ? <RestartChip /> : null}
                                </div>
                                <div className="flex items-center min-w-0 gap-1.5 text-small text-default-500">
                                    <StatusDot kind={state.kind} />
                                    <span className="shrink-0">{state.label}</span>
                                    <span aria-hidden={true} className="text-default-300">
                                        ·
                                    </span>
                                    <span className="font-mono truncate text-tiny">
                                        {mount.mountPoint}
                                    </span>
                                    {mount.uploadsPending > 0 ? (
                                        <span className="shrink-0 tabular-nums">
                                            · {uploading(mount.uploadsPending)}
                                        </span>
                                    ) : null}
                                </div>
                                {mount.error ? (
                                    <span className="text-tiny text-danger line-clamp-2">
                                        {mount.error}
                                    </span>
                                ) : null}
                            </div>
                            <Button
                                size="sm"
                                variant="flat"
                                startContent={<FolderIcon className="size-4" />}
                                isDisabled={mount.state !== 'running'}
                                onPress={() =>
                                    revealPath(mount.mountPoint).catch((error) =>
                                        said(t`Open`, error)
                                    )
                                }
                                data-focus-visible="false"
                            >
                                <Trans>Open</Trans>
                            </Button>
                            <Button
                                size="sm"
                                variant="flat"
                                color="danger"
                                isLoading={stopping === mount.id}
                                isDisabled={stopping !== null && stopping !== mount.id}
                                onPress={() => unmount(mount)}
                                data-focus-visible="false"
                            >
                                <Trans>Unmount</Trans>
                            </Button>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}

/**
 * The stopped mounts whose cache still holds uploads, which are never deleted automatically.
 * Mount again reuses the same cache and uploads them, and Discard deletes them.
 */
export function StoppedMounts() {
    const { mounts: stopped, query } = useStoppedMounts()
    const [busy, setBusy] = useState<string | null>(null)
    const error = query.isError ? (
        <LoadFailedNotice
            title={t`Couldn't look for uploads left by stopped mounts`}
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => query.refetch()}
        />
    ) : null
    if (stopped.length === 0) return error
    const again = async (mount: Mounts.StoppedRow) => {
        setBusy(mount.folder)
        try {
            await mountAgain(mount.folder)
        } catch (error) {
            // On a computer that can't mount, the can't-mount dialog explains how to set it up.
            if (cannotMount(error) && (await explainMountSupport().catch(() => false))) return
            await said(cannotMount(error) ? t`Mount again` : t`The mount failed`, error)
        } finally {
            setBusy(null)
        }
    }
    const discard = async (mount: Mounts.StoppedRow) => {
        const sure = await ask(neverUploaded(mount.pending, mount.source), {
            title: t`Discard the pending uploads?`,
            kind: 'warning',
            destructive: true,
            okLabel: t`Discard`,
        })
        if (!sure) return
        setBusy(mount.folder)
        try {
            await discardStopped(mount.folder)
            toastSuccess(t`The pending uploads have been discarded`)
        } catch (error) {
            await said(t`Discard`, error)
        } finally {
            setBusy(null)
        }
    }
    return (
        <section aria-label={t`Pending uploads`} className="flex flex-col gap-3">
            {error}
            {stopped.map((mount) => (
                <div
                    key={mount.folder}
                    className={cn(SURFACE, 'flex items-center gap-3.5 px-4 py-3')}
                >
                    <IconTile icon={CloudArrowUpIcon} tone="orange" size="lg" />
                    <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                        <span className="font-medium text-pretty">
                            {waitingToUpload(mount.pending)}
                        </span>
                        <span className="truncate text-small text-default-500">
                            <Trans>
                                From a stopped mount of {mount.source} at{' '}
                                <span className="font-mono text-tiny">{mount.mountPoint}</span>
                            </Trans>
                        </span>
                    </div>
                    <Button
                        size="sm"
                        variant="flat"
                        color="primary"
                        isLoading={busy === mount.folder}
                        isDisabled={busy !== null}
                        onPress={() => again(mount)}
                        data-focus-visible="false"
                    >
                        <Trans>Mount again</Trans>
                    </Button>
                    <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        isDisabled={busy !== null}
                        onPress={() => discard(mount)}
                        data-focus-visible="false"
                    >
                        <Trans>Discard</Trans>
                    </Button>
                </div>
            ))}
        </section>
    )
}
