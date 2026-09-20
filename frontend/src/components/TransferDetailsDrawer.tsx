import {
    Alert,
    Button,
    Chip,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerHeader,
    Progress,
    Spinner,
    Tooltip,
    cn,
    useDisclosure,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
    ChevronDownIcon,
    ExternalLinkIcon,
    RotateCcwIcon,
    SlidersHorizontalIcon,
    SquareIcon,
    XIcon,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatBytes } from '../../lib/format'
import { notify } from '../../lib/notifications'
import { transfersDetail, transfersStop } from '../../lib/api/transfers'
import type { OperationPreset } from '../../lib/rclone/preset'
import { generalErrors, splitFiles } from '../../lib/transfers/details'
import { isLive, liveJob } from '../../lib/transfers/live'
import { rerunEffect, retryPlan } from '../../lib/transfers/retry'
import { ENDED, type TransferRow } from '../../lib/transfers/rows'
import { useHostStore } from '../../store/host'
import TransferRetryDrawer from './TransferRetryDrawer'
import { message } from '../../lib/api/dialog'
import { OPERATIONS } from './OperationGrid'
import { openOperation } from './operation/useOperationPreset'

/** A transfer's files by where they are: the first two only while it runs. */
type SectionKey = 'checking' | 'transferring' | 'transferred' | 'failed'

// What is in here comes from two places and never both. A running transfer is read live from
// rclone, once a second. One that has ended — finished, stopped, interrupted — is read once from
// what the server kept, and rclone is not asked at all.
export default function TransferDetailsDrawer({
    isOpen,
    onClose,
    transfer,
    related,
    onSelectTransfer,
}: {
    isOpen: boolean
    onClose: () => void
    transfer: TransferRow
    /** The transfer this one retries, and the retries made of this one. */
    related: { original: TransferRow | null; retries: TransferRow[] }
    onSelectTransfer: (id: string) => void
}) {
    const queryClient = useQueryClient()
    const retryDrawer = useDisclosure()
    // Here and not in each section: one that empties for a second while the transfer runs comes
    // back the way it was left.
    const [closed, setClosed] = useState<Set<SectionKey>>(new Set())
    const section = (key: SectionKey) => ({
        isOpen: !closed.has(key),
        onToggle: () =>
            setClosed((previous) => {
                const next = new Set(previous)
                if (!next.delete(key)) next.add(key)
                return next
            }),
    })

    const live = isLive(transfer)

    const liveQuery = useQuery({
        queryKey: ['transfers', 'live', 'job', transfer.id],
        queryFn: () => liveJob(transfer.jobid),
        enabled: live,
        refetchInterval: 1000,
        meta: { persist: false },
    })

    const detailQuery = useQuery({
        queryKey: ['transfers', 'detail', transfer.id],
        queryFn: () => transfersDetail(transfer.id),
        enabled: !live,
    })

    const status = live ? (liveQuery.data?.status ?? undefined) : detailQuery.data?.status
    const isLoading = live ? liveQuery.isLoading : detailQuery.isLoading

    // What the page had set when it started this.
    const preset = (transfer.preset as OperationPreset | undefined) ?? null
    const presetLabel = preset
        ? (OPERATIONS.find((entry) => entry.id === preset.operation)?.label ?? preset.operation)
        : undefined

    const stopJobMutation = useMutation({
        // The server stops it and records it as stopped in one go, so the "context canceled" the
        // job ends with is never read as a failure.
        mutationFn: (id: string) => transfersStop(id),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ['transfers', 'list'] })
            await notify({ title: 'Transfer stopped', body: 'It is listed under Inactive now.' })
        },
        onError: async (error) => {
            console.error('Failed to stop the transfer:', error)
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Could not stop the transfer',
                kind: 'error',
            })
        },
    })

    // The files that are done, each under how it ended; the ones in flight only while it runs.
    const files = useMemo(
        () =>
            live
                ? splitFiles(liveQuery.data?.transferred)
                : splitFiles(detailQuery.data?.transferred, detailQuery.data?.failed),
        [live, liveQuery.data, detailQuery.data]
    )
    const transferring = (live && liveQuery.data?.transferring) || []
    const checking = (live && liveQuery.data?.checking) || []
    const isEmpty =
        checking.length + transferring.length + files.transferred.length + files.failed.length === 0

    // Only what no file's row already says (`generalErrors`).
    const general = useMemo(
        () => generalErrors({ status, recorded: transfer.error, failed: files.failed }),
        [status, transfer.error, files.failed]
    )

    // The operation's page with this transfer's settings: the header's Reuse settings, and what
    // the note that says "run it again" offers.
    const openItsPage = () => {
        if (!preset) return
        openOperation(preset)
    }

    // What of it can be retried. Only of a transfer that is over (which inputs failed is not
    // known before) and whose record has the request it was started with.
    const navigate = useNavigate()
    const scheduledTasks = useHostStore((state) => state.scheduledTasks)
    // Whether the schedule that ran it is still there to open.
    const scheduleExists = useMemo(
        () => scheduledTasks.some((task) => task.id === transfer.scheduled?.taskId),
        [scheduledTasks, transfer.scheduled]
    )

    const retryable = useMemo(
        () => (transfer.state === 'running' ? [] : retryPlan(detailQuery.data)),
        [transfer.state, detailQuery.data]
    )

    const details = (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="2xl"
            onClose={onClose}
            // Its close button is the header's own, in line with the other two.
            hideCloseButton={true}
            // Two stacked drawers both read a click beside the top one as "outside".
            isDismissable={!retryDrawer.isOpen}
            isKeyboardDismissDisabled={retryDrawer.isOpen}
        >
            <DrawerContent
                className={cn('bg-content1/80 backdrop-blur-md dark:bg-content1/90', undefined)}
            >
                <DrawerHeader className="flex flex-row items-center gap-2">
                    Transfer Details #{transfer.jobid}{' '}
                    {transfer.state !== 'running' ? (
                        <Chip color={ENDED[transfer.state].color} size="sm">
                            {ENDED[transfer.state].label.toUpperCase()}
                        </Chip>
                    ) : !live ? (
                        <Chip color="success" size="sm">
                            RUNNING
                        </Chip>
                    ) : (
                        <Tooltip content="Stop transfer" placement="right" color="foreground">
                            <Button
                                isIconOnly={true}
                                color="danger"
                                size="sm"
                                variant="light"
                                onPress={() => {
                                    stopJobMutation.mutate(transfer.id)
                                }}
                            >
                                <SquareIcon fill="currentColor" className="w-5 rounded-small" />
                            </Button>
                        </Tooltip>
                    )}
                    {related.original && (
                        <Tooltip content="Open the transfer this one retries" color="foreground">
                            <Chip
                                as="button"
                                size="sm"
                                variant="flat"
                                onClick={() => onSelectTransfer(related.original!.id)}
                            >
                                Retry of #{related.original.jobid}
                            </Chip>
                        </Tooltip>
                    )}
                    <div className="flex flex-row items-center gap-2 ml-auto">
                        {retryable.length > 0 && (
                            <Tooltip
                                content="Choose failed files to retry"
                                placement="bottom"
                                color="foreground"
                            >
                                <Button
                                    size="sm"
                                    variant="flat"
                                    color="warning"
                                    startContent={<RotateCcwIcon className="w-4 h-4" />}
                                    onPress={retryDrawer.onOpen}
                                >
                                    Retry failed · {retryable.length}
                                </Button>
                            </Tooltip>
                        )}
                        {preset && (
                            <Tooltip
                                content={`Open ${presetLabel} with these settings`}
                                placement="bottom"
                                color="foreground"
                            >
                                <Button
                                    size="sm"
                                    variant="flat"
                                    startContent={<SlidersHorizontalIcon className="w-4 h-4" />}
                                    onPress={openItsPage}
                                >
                                    Reuse settings
                                </Button>
                            </Tooltip>
                        )}
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            aria-label="Close"
                            onPress={onClose}
                        >
                            <XIcon className="size-4" />
                        </Button>
                    </div>
                </DrawerHeader>
                <DrawerBody className="pb-10">
                    {related.retries.length > 0 && (
                        <div className="flex flex-row flex-wrap items-center gap-2">
                            {related.retries.map((retry) => (
                                <Chip
                                    key={retry.id}
                                    as="button"
                                    size="sm"
                                    variant="flat"
                                    color={
                                        retry.state === 'completed'
                                            ? 'success'
                                            : retry.state === 'running'
                                              ? 'primary'
                                              : 'danger'
                                    }
                                    endContent={<ExternalLinkIcon className="w-3 h-3 mr-1" />}
                                    onClick={() => onSelectTransfer(retry.id)}
                                >
                                    Retried as #{retry.jobid}
                                </Chip>
                            ))}
                        </div>
                    )}

                    {general.length > 0 && (
                        <Alert color="danger" variant="faded" hideIcon={true}>
                            <ul className="flex flex-col gap-1">
                                {general.map((item) => (
                                    <li
                                        key={`${item.subject}\n${item.error}`}
                                        className="[overflow-wrap:anywhere]"
                                    >
                                        {item.subject && (
                                            <span className="font-medium">{item.subject}: </span>
                                        )}
                                        {item.error}
                                    </li>
                                ))}
                            </ul>
                        </Alert>
                    )}

                    {transfer.state === 'interrupted' && (
                        <Alert
                            color="warning"
                            variant="faded"
                            title="Its rclone daemon stopped while this was running."
                            endContent={
                                preset ? (
                                    <Button
                                        size="sm"
                                        variant="flat"
                                        color="warning"
                                        className="shrink-0"
                                        onPress={openItsPage}
                                    >
                                        Open {presetLabel}
                                    </Button>
                                ) : undefined
                            }
                        >
                            Run it again to carry on from here. {rerunEffect(transfer.operation)}
                        </Alert>
                    )}

                    {transfer.scheduled && (
                        <Alert color="default" variant="faded">
                            <div className="flex flex-row items-center justify-between w-full gap-3">
                                <span>
                                    Started by the schedule “
                                    {transfer.scheduled.name ?? transfer.operation}”
                                    {scheduleExists ? '.' : ', which no longer exists.'}
                                </span>
                                {scheduleExists && (
                                    <Button
                                        size="sm"
                                        variant="flat"
                                        className="shrink-0"
                                        onPress={() => {
                                            onClose()
                                            navigate(
                                                `/schedules?task=${transfer.scheduled?.taskId}`
                                            )
                                        }}
                                        data-focus-visible="false"
                                    >
                                        Open schedule
                                    </Button>
                                )}
                            </div>
                        </Alert>
                    )}

                    {transfer.isDryRun && (
                        <Alert color="warning" variant="faded">
                            This is a dry-run operation. No files were actually transferred.
                        </Alert>
                    )}

                    {/* A section is there when it holds something, and not otherwise. */}
                    <div className="flex flex-col gap-6 pt-2">
                        {checking.length > 0 && (
                            <Section
                                title="Checking"
                                count={checking.length}
                                {...section('checking')}
                            >
                                <p className="text-sm text-default-500">
                                    Files are being verified before transfer. This can take a while
                                    for large directories.
                                </p>
                                {checking.map((item, itemIndex) => (
                                    <div
                                        key={item.name || itemIndex}
                                        className="flex flex-row items-center justify-between gap-2 pb-2 border-b border-divider"
                                    >
                                        <p className="flex-1 min-w-0 truncate">{item.name}</p>
                                        <p className="text-sm tabular-nums text-default-500">
                                            {item.size ? formatBytes(item.size) : 'Unknown size'}
                                        </p>
                                    </div>
                                ))}
                            </Section>
                        )}

                        {transferring.length > 0 && (
                            <Section
                                title="Transferring"
                                count={transferring.length}
                                {...section('transferring')}
                            >
                                {transferring.map((item, itemIndex) => {
                                    // biome-ignore lint/style/useExplicitLengthCheck: <not relevant>
                                    const size = item.size ? formatBytes(item.size) : '0 B'
                                    const bytes = item.bytes ? formatBytes(item.bytes) : '0 B'
                                    const speed = item.speed ? formatBytes(item.speed) : '0 B'
                                    return (
                                        <div
                                            key={item.name || itemIndex}
                                            className="flex flex-row items-center justify-between gap-5 pb-2 border-b border-divider"
                                        >
                                            <p className="flex-1 line-clamp-1 min-w-80">
                                                {item.name}
                                            </p>
                                            <p className="w-24 tabular-nums shrink-0 whitespace-nowrap">
                                                {speed}/s
                                            </p>
                                            <Tooltip
                                                content={`Transferred ${bytes} of ${size}`}
                                                color="foreground"
                                                placement="bottom"
                                                size="lg"
                                            >
                                                <Progress
                                                    value={item.percentage}
                                                    classNames={{
                                                        base: 'overflow-hidden rounded-full max-w-lg',
                                                    }}
                                                />
                                            </Tooltip>
                                        </div>
                                    )
                                })}
                            </Section>
                        )}

                        {files.transferred.length > 0 && (
                            <Section
                                title="Transferred"
                                count={files.transferred.length}
                                {...section('transferred')}
                            >
                                {files.transferred.map((item, itemIndex) => (
                                    <div
                                        key={item.name || `item-${itemIndex}`}
                                        className="flex flex-row items-center justify-between gap-2 pb-2 border-b border-divider"
                                    >
                                        <p className="flex-1 min-w-0 truncate">{item.name}</p>
                                        {item.completed_at && (
                                            <p className="text-sm text-default-500">
                                                {new Date(item.completed_at).toLocaleString()}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </Section>
                        )}

                        {files.failed.length > 0 && (
                            <Section
                                title="Failed"
                                count={files.failed.length}
                                {...section('failed')}
                            >
                                {files.failed.map((item, itemIndex) => (
                                    // The whole of rclone's error: this row is where it is read.
                                    <div
                                        key={item.name || `item-${itemIndex}`}
                                        className="flex flex-col gap-0.5 pb-2 border-b border-divider"
                                    >
                                        <p className="truncate">{item.name}</p>
                                        <p
                                            className="text-sm line-clamp-2 text-danger [overflow-wrap:anywhere]"
                                            title={item.error}
                                        >
                                            {item.error}
                                        </p>
                                    </div>
                                ))}
                            </Section>
                        )}

                        {isLoading ? (
                            <Spinner />
                        ) : isEmpty ? (
                            <p className="text-default-500">
                                {live
                                    ? transfer.listed > 0
                                        ? `Preparing · ${transfer.listed.toLocaleString()} entries listed`
                                        : 'Preparing'
                                    : transfer.state === 'running'
                                      ? 'Its files are listed here once it ends.'
                                      : 'No files were transferred.'}
                            </p>
                        ) : null}
                    </div>
                </DrawerBody>
            </DrawerContent>
        </Drawer>
    )

    return (
        <>
            {details}
            {detailQuery.data && retryable.length > 0 && (
                <TransferRetryDrawer
                    isOpen={retryDrawer.isOpen}
                    onClose={retryDrawer.onClose}
                    transfer={transfer}
                    detail={detailQuery.data}
                    items={retryable}
                />
            )}
        </>
    )
}

/** One stage of a transfer and what is in it, folded or not. Rendered only with something in it. */
function Section({
    title,
    count,
    isOpen,
    onToggle,
    children,
}: {
    title: string
    count: number
    isOpen: boolean
    onToggle: () => void
    children: ReactNode
}) {
    return (
        <section aria-label={title} className="flex flex-col gap-2">
            <h3 className="text-lg font-medium">
                <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={onToggle}
                    className="flex flex-row items-center w-full gap-1.5 text-left rounded-small outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                    {title}
                    <ChevronDownIcon
                        className={cn(
                            'size-4 text-default-500 transition-transform',
                            !isOpen && '-rotate-90'
                        )}
                    />
                    <span className="ml-auto text-sm font-normal tabular-nums text-default-500">
                        {count.toLocaleString()} item{count === 1 ? '' : 's'}
                    </span>
                </button>
            </h3>
            {isOpen && children}
        </section>
    )
}
