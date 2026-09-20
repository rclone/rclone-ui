import { Button, Progress, ScrollShadow, Tooltip } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftRightIcon, CheckCircle2Icon, ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, LoaderIcon, PencilIcon, SearchCheckIcon, XCircleIcon } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { formatBytes } from '@/lib/format'
import { transfersDetail } from '@/server/transfers'
import { splitFiles } from '@/lib/transfers/details'
import { isLive, liveJob } from '@/lib/transfers/live'
import { useTransferRows } from '@/lib/transfers/useTransferRows'

import { PlacesMenu } from '@/components/navigator'
import { navigate } from '@/navigate'


// An icon action in the bar's header row. The wrapping div keeps the tooltip working (and
// explaining) when the button is disabled, and stops the click from toggling the bar.
function BarAction({
    label,
    disabledReason,
    onPress,
    children,
}: {
    label: string
    disabledReason?: string
    onPress: () => void
    children: ReactNode
}) {
    return (
        <Tooltip content={disabledReason ?? label} size="sm">
            <div onClick={(e) => e.stopPropagation()}>
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    aria-label={label}
                    isDisabled={!!disabledReason}
                    onPress={onPress}
                >
                    {children}
                </Button>
            </div>
        </Tooltip>
    )
}

export default function TransfersBar({
    trackedIds,
    onOpenCompare,
    compareDisabledReason,
    onOpenBatchRename,
    renameDisabledReason,
}: {
    trackedIds: Set<string>
    onOpenCompare: () => void
    compareDisabledReason?: string
    onOpenBatchRename: () => void
    renameDisabledReason?: string
}) {
    const [isExpanded, setIsExpanded] = useState(false)

    // The transfers this page started, drops and downloads alike (all recorded, tagged
    // `commander`). Which of them still run, and when one has ended, is the record's to say:
    // rclone is asked only for the files of the running ones, and an ended one's files are read
    // once from what the server kept.
    const { rows } = useTransferRows({ enabled: trackedIds.size > 0 })
    const mine = useMemo(
        () => [...rows.active, ...rows.inactive].filter((row) => trackedIds.has(row.id)),
        [rows, trackedIds]
    )
    const running = mine.filter(isLive)
    const liveQuery = useQuery({
        queryKey: ['commander', 'live', running.map((row) => row.id)],
        queryFn: () => Promise.all(running.map((row) => liveJob(row.jobid))),
        refetchInterval: 1000,
        enabled: running.length > 0,
        meta: { persist: false },
    })
    const endedQueries = useQueries({
        queries: mine
            .filter((row) => row.state !== 'running')
            .map((row) => ({
                queryKey: ['transfers', 'detail', row.id],
                queryFn: () => transfersDetail(row.id),
                staleTime: Number.POSITIVE_INFINITY,
            })),
    })

    const jobs = running.length > 0 ? (liveQuery.data ?? []) : []
    const transferring = jobs.flatMap((job) => job.transferring)
    const checking = jobs.flatMap((job) => job.checking)
    const transferred = [
        ...endedQueries.flatMap((query) => {
            const files = splitFiles(query.data?.transferred, query.data?.failed)
            return [...files.transferred, ...files.failed]
        }),
        ...jobs.flatMap((job) => job.transferred),
    ]

    const hasTransfers =
        transferring.length + checking.length + transferred.length > 0 ||
        endedQueries.some((query) => query.isLoading)

    const toggleExpanded = useCallback(() => {
        setIsExpanded((prev) => !prev)
    }, [])

    const handleOpenTransfers = useCallback(() => navigate('/transfers'), [])

    return (
        <div
            role="region"
            aria-label="Page activity"
            className="border-t border-divider bg-content1"
        >
            <div
                className="flex items-center justify-between h-10 px-4 cursor-pointer select-none hover:bg-content2"
                onClick={toggleExpanded}
            >
                <div className="flex items-center gap-2">
                    <PlacesMenu />
                    <BarAction
                        label="Batch Rename"
                        disabledReason={renameDisabledReason}
                        onPress={onOpenBatchRename}
                    >
                        <PencilIcon className="size-4" />
                    </BarAction>
                    <BarAction
                        label="Compare"
                        disabledReason={compareDisabledReason}
                        onPress={onOpenCompare}
                    >
                        <ArrowLeftRightIcon className="size-4" />
                    </BarAction>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-3">
                        {running.length > 0 && (
                            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary-100 text-primary-700">
                                {running.length} active
                            </span>
                        )}
                        {!hasTransfers && running.length === 0 && (
                            <span className="text-sm text-default-400">No active transfers</span>
                        )}
                    </div>
                    <Tooltip content="Open Transfers page" size="sm">
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            onPress={handleOpenTransfers}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <ExternalLinkIcon className="size-4" />
                        </Button>
                    </Tooltip>
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        aria-label={isExpanded ? 'Hide activity' : 'Show activity'}
                        onPress={toggleExpanded}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {isExpanded ? (
                            <ChevronDownIcon className="size-4" />
                        ) : (
                            <ChevronUpIcon className="size-4" />
                        )}
                    </Button>
                </div>
            </div>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: '40vh', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden border-t border-divider"
                    >
                        <ScrollShadow className="h-[40vh] p-2">
                            {hasTransfers ? (
                                <div className="space-y-1">
                                    {checking.map((item: any, idx: number) => (
                                        <TransferItem
                                            key={`checking-${item.name}-${idx}`}
                                            item={item}
                                            status="checking"
                                        />
                                    ))}
                                    {transferring.map((item: any, idx: number) => (
                                        <TransferItem
                                            key={`transferring-${item.name}-${idx}`}
                                            item={item}
                                            status="transferring"
                                        />
                                    ))}
                                    {transferred.map((item: any, idx: number) => (
                                        <TransferItem
                                            key={`transferred-${item.name}-${idx}`}
                                            item={item}
                                            status={item.error ? 'error' : 'done'}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div className="flex items-center justify-center h-full text-sm text-default-400">
                                    No transfers in progress
                                </div>
                            )}
                        </ScrollShadow>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

function TransferItem({
    item,
    status,
}: {
    item: {
        name?: string
        size?: number
        bytes?: number
        percentage?: number
        speed?: number
        error?: string
    }
    status: 'transferring' | 'checking' | 'done' | 'error'
}) {
    const fileName = item.name?.split('/').pop() || item.name || 'Unknown'

    return (
        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-content2">
            <div className="shrink-0">
                {status === 'error' ? (
                    <XCircleIcon className="text-danger size-4" />
                ) : status === 'done' ? (
                    <CheckCircle2Icon className="text-success size-4" />
                ) : status === 'checking' ? (
                    <SearchCheckIcon className="text-warning size-4 animate-pulse" />
                ) : (
                    <LoaderIcon className="text-primary size-4 animate-spin" />
                )}
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm truncate" title={item.name}>
                        {fileName}
                    </span>
                    <span className="text-xs shrink-0 text-default-500">
                        {status === 'error'
                            ? 'Failed'
                            : status === 'done'
                              ? formatBytes(item.size || 0)
                              : status === 'checking'
                                ? 'Checking...'
                                : (item.size || 0) > 0
                                  ? `${formatBytes(item.bytes || 0)} / ${formatBytes(item.size || 0)}`
                                  : '—'}
                    </span>
                </div>

                {(status === 'transferring' || status === 'checking') && (
                    <div className="flex items-center gap-2">
                        <Progress
                            value={item.percentage || 0}
                            size="sm"
                            color={status === 'checking' ? 'warning' : 'primary'}
                            className="flex-1"
                            aria-label="Transfer progress"
                            isIndeterminate={status === 'checking'}
                        />
                        {(item.speed || 0) > 0 && (
                            <span className="text-xs shrink-0 text-default-400">
                                {formatBytes(item.speed || 0)}/s
                            </span>
                        )}
                    </div>
                )}

                {status === 'done' && item.name && (
                    <span className="text-xs truncate text-default-400" title={item.name}>
                        {item.name}
                    </span>
                )}

                {status === 'error' && item.error && (
                    <span className="text-xs truncate text-danger" title={item.error}>
                        {item.error}
                    </span>
                )}
            </div>
        </div>
    )
}
