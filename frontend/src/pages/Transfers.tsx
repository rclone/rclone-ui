import { Card, CardBody, Progress, Tab, Tabs, Tooltip, useDisclosure } from '@heroui/react'
import { Button, Chip, Spinner, cn } from '@heroui/react'

import {
    ActivityIcon,
    ChevronRightIcon,
    ClockIcon,
    FolderTreeIcon,
    RefreshCcwIcon,
    SearchCheckIcon,
} from 'lucide-react'
import { startTransition, useCallback, useMemo, useState } from 'react'
import { message } from '../../lib/api/dialog'
import { openWindow } from '../../lib/api/windows'
import { buildReadablePathMultiple, formatBytes } from '../../lib/format'
import { useIsPreview } from '../../lib/preview'
import { ENDED, type TransferRow } from '../../lib/transfers/rows'
import { useTransferRows } from '../../lib/transfers/useTransferRows'
import { useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import EmptyState from '../components/EmptyState'
import TransferDetailsDrawer from '../components/TransferDetailsDrawer'

export default function Transfers() {
    const { isOpen, onOpen, onClose } = useDisclosure({
        onClose: () => {
            setTimeout(() => {
                startTransition(() => {
                    setSelectedId(null)
                })
                if (!acknowledgements.includes('escToCloseJobDetails')) {
                    message('You can close the transfer details panel by pressing the ESC key.', {
                        title: 'Did you know?',
                        buttons: {
                            ok: 'Good to know',
                        },
                    }).then(() => {
                        usePersistedStore.setState((prev) => ({
                            acknowledgements: [...prev.acknowledgements, 'escToCloseJobDetails'],
                        }))
                    })
                }
            }, 500)
        },
    })
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const acknowledgements = usePersistedStore((state) => state.acknowledgements)
    const scheduledTasks = useHostStore((state) => state.scheduledTasks)
    const { rows: transfers, query: transfersQuery } = useTransferRows()
    // The open drawer follows its row: a transfer that ends while it is open stops being live.
    const selected = useMemo(
        () =>
            [...transfers.active, ...transfers.inactive].find((row) => row.id === selectedId) ??
            null,
        [transfers, selectedId]
    )

    const handleSelect = useCallback(
        (row: TransferRow) => {
            // A scheduled run belongs to its schedule: that is where its history and logs are.
            // A new tab in a browser, a window of its own on the desktop. One whose schedule is
            // gone has nowhere to go and opens here with what the record kept.
            const schedule = row.scheduled
            if (schedule && scheduledTasks.some((task) => task.id === schedule.taskId)) {
                const search = new URLSearchParams({ task: schedule.taskId })
                if (schedule.runId) search.set('run', schedule.runId)
                openWindow({ name: 'Schedules', url: `/schedules?${search}`, newTab: true })
                return
            }
            setSelectedId(row.id)
            onOpen()
        },
        [onOpen, scheduledTasks]
    )

    // A transfer and its retries point at each other: the record says which transfer a retry
    // retries, and the list in hand says which retries were made of one.
    const related = useMemo(() => {
        const rows = [...transfers.active, ...transfers.inactive]
        return {
            original: rows.find((row) => row.id === selected?.retryOf) ?? null,
            retries: rows.filter((row) => !!selected && row.retryOf === selected.id),
        }
    }, [transfers, selected])

    if (transfersQuery.isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-screen">
                <Spinner size="lg" />
            </div>
        )
    }

    if (!transfers || (transfers.active.length === 0 && transfers.inactive.length === 0)) {
        return (
            <div className="w-full h-screen overflow-y-auto">
                <EmptyState
                    icon={ActivityIcon}
                    title="Nothing has moved yet"
                    description="Every copy, move, sync and bisync you start shows up here with its progress, speed and result, scheduled runs included. It stays after a restart."
                    actions={
                        <Button
                            variant="flat"
                            startContent={
                                <RefreshCcwIcon
                                    className={cn(
                                        'size-4',
                                        transfersQuery.isRefetching && 'animate-spin'
                                    )}
                                />
                            }
                            onPress={() => transfersQuery.refetch()}
                            data-focus-visible="false"
                        >
                            Refresh
                        </Button>
                    }
                />
            </div>
        )
    }

    return (
        <>
            <Tabs
                fullWidth={true}
                size="lg"
                classNames={{
                    // The desktop window pins the tabs under its title bar. In the browser shell the
                    // page is a scrolling sheet, so the bar sticks inside it instead of covering the
                    // site header.
                    tabList: 'sticky top-0 z-40 !bg-content2',
                    panel: 'min-h-[calc(100vh-1.5rem)] p-0',
                }}
                variant="underlined"
            >
                <Tab key="active" title="ACTIVE">
                    {transfers.active.map((row) => (
                        <TransferCard key={row.id} row={row} onSelect={handleSelect} />
                    ))}
                </Tab>
                <Tab key="inactive" title="INACTIVE">
                    {transfers.inactive.map((row) => (
                        <TransferCard key={row.id} row={row} onSelect={handleSelect} />
                    ))}
                </Tab>
            </Tabs>

            <RefreshButton
                isRefreshing={transfersQuery.isRefetching}
                onRefresh={transfersQuery.refetch}
            />

            {selected && (
                <TransferDetailsDrawer
                    isOpen={isOpen}
                    onClose={onClose}
                    transfer={selected}
                    related={related}
                    onSelectTransfer={setSelectedId}
                />
            )}
        </>
    )
}

/** What an ended transfer says next to its paths; a completed one says nothing. */
/** Where a transfer came from, as the list says it: one badge for each of its tags. */
const ORIGINS: Record<string, { label: string; about: string; icon?: typeof ClockIcon }> = {
    schedule: { label: 'Schedule', about: 'Run by a schedule.', icon: ClockIcon },
    operation: { label: 'Operation', about: 'Started from an operation’s page.' },
    commander: { label: 'Commander', about: 'Started from the Commander.', icon: FolderTreeIcon },
}

function OriginBadges({ row }: { row: TransferRow }) {
    return row.tags.map((tag) => {
        const origin = ORIGINS[tag]
        if (!origin) return null
        const Icon = origin.icon
        return (
            <Tooltip
                key={tag}
                content={
                    tag === 'schedule' && row.scheduled
                        ? `Run by the schedule “${row.scheduled.name ?? row.operation}”. Opens it in Schedules.`
                        : origin.about
                }
                color="foreground"
            >
                <Chip
                    size="sm"
                    variant="flat"
                    color={tag === 'schedule' ? 'secondary' : 'default'}
                    startContent={Icon ? <Icon className="w-3 h-3 ml-1" /> : undefined}
                >
                    {origin.label}
                </Chip>
            </Tooltip>
        )
    })
}

/** What the list says of an end that is not the expected one. */
function endedLabel(row: TransferRow) {
    if (row.state === 'stopped') return `${ENDED.stopped.label} at ${row.progress}%`
    if (row.state === 'interrupted' || row.state === 'unknown') return ENDED[row.state].label
    return null
}

function TransferCard({
    row,
    onSelect,
}: { row: TransferRow; onSelect: (row: TransferRow) => void }) {
    const isPreview = useIsPreview()
    const isActive = row.type === 'active'
    // Nothing to measure against until rclone has sized the transfer (or, for a scheduled run on
    // its own daemon, at all).
    const isIndeterminate = isActive && row.totalBytes === 0
    const ended = endedLabel(row)
    const hasFailed = row.state === 'failed'
    return (
        <Card
            radius="none"
            shadow="none"
            style={{
                flexShrink: 0,
            }}
            className="w-full border-b border-divider"
            onPress={() => onSelect(row)}
            isPressable={true}
            data-focus-visible="false"
        >
            <CardBody className="p-0 py-1">
                <div className="flex flex-row items-center w-full">
                    <Tooltip content="Job ID" placement="right" color="foreground">
                        <Chip
                            isCloseable={false}
                            size="lg"
                            variant="flat"
                            color={isActive ? 'success' : 'primary'}
                            className="mx-2"
                        >
                            #{row.jobid}
                        </Chip>
                    </Tooltip>

                    <div className="flex flex-row items-center flex-1 gap-2">
                        {hasFailed && (
                            <p className="flex-1 text-left text-danger">
                                ERROR: Tap to view details.
                            </p>
                        )}
                        {hasFailed && <OriginBadges row={row} />}

                        {!hasFailed && (
                            <>
                                <p className="flex-1 font-bold text-left line-clamp-1 text-large min-w-80">
                                    {buildReadablePathMultiple(row.sources, 'short', true)}
                                </p>

                                {ended ? <p className="text-gray-500">{ended}</p> : null}

                                <OriginBadges row={row} />

                                {row.isDryRun && (
                                    <Chip size="sm" variant="flat" color="warning">
                                        DRY RUN
                                    </Chip>
                                )}

                                {row.phase === 'preparing' && !row.scheduled ? (
                                    <Tooltip
                                        content="rclone is opening both ends and listing them. Nothing moves until that is done."
                                        color="foreground"
                                    >
                                        <Chip size="sm" variant="flat" color="default">
                                            {row.listed > 0
                                                ? `Preparing · ${row.listed.toLocaleString()} listed`
                                                : 'Preparing'}
                                        </Chip>
                                    </Tooltip>
                                ) : null}

                                {row.phase === 'checking' ? (
                                    <Tooltip
                                        content={`Checking ${row.checkingCount} file${row.checkingCount === 1 ? '' : 's'} before transfer`}
                                        color="foreground"
                                    >
                                        <Chip
                                            size="sm"
                                            variant="flat"
                                            color="warning"
                                            startContent={<SearchCheckIcon className="w-3 h-3" />}
                                        >
                                            Checking {row.checkingCount}
                                        </Chip>
                                    </Tooltip>
                                ) : null}

                                {isActive ? (
                                    <Tooltip
                                        content={`${formatBytes(row.bytes)} out of ${formatBytes(row.totalBytes)}`}
                                    >
                                        <Progress
                                            aria-label="Progress"
                                            value={row.progress}
                                            disableAnimation={isPreview}
                                            isStriped={!isIndeterminate}
                                            isIndeterminate={isIndeterminate}
                                        />
                                    </Tooltip>
                                ) : null}
                                {isActive && !row.scheduled ? (
                                    <p className="w-24 text-sm text-right shrink-0 tabular-nums text-default-500">
                                        {formatBytes(row.speed)}/s
                                    </p>
                                ) : null}
                            </>
                        )}
                    </div>

                    <Button
                        isIconOnly={true}
                        variant="light"
                        onPress={() => onSelect(row)}
                        data-focus-visible="false"
                    >
                        <ChevronRightIcon className="w-5" />
                    </Button>
                </div>
            </CardBody>
        </Card>
    )
}

function RefreshButton({
    isRefreshing,
    onRefresh,
}: { isRefreshing: boolean; onRefresh: () => void }) {
    return (
        <Button
            size="lg"
            isIconOnly={true}
            radius="full"
            color="primary"
            className="absolute bottom-5 right-6"
            onPress={() => {
                setTimeout(async () => {
                    onRefresh()
                }, 100)
            }}
            startContent={
                <RefreshCcwIcon size={28} className={isRefreshing ? 'animate-spin' : ''} />
            }
        />
    )
}
