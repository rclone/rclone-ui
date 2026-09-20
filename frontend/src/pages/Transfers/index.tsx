import { Card, CardBody, Progress, Tab, Tabs, Tooltip } from '@heroui/react'
import { Button, Chip, Spinner, cn } from '@heroui/react'

import {
    ActivityIcon,
    ChevronRightIcon,
    ClockIcon,
    FolderTreeIcon,
    RefreshCcwIcon,
    SearchCheckIcon,
} from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { message } from '@/dialog'
import { buildReadablePathMultiple, formatBytes } from '@/lib/format'
import { ENDED, type TransferRow } from '@/lib/transfers/rows'
import { useTransferRows } from '@/lib/transfers/useTransferRows'
import { usePersistedStore } from '@/store'
import EmptyState from '@/components/EmptyState'
import TransferDetailsDrawer from './TransferDetailsDrawer'

export default function Transfers() {
    const navigate = useNavigate()
    // The details drawer is a route (`/transfers/<id>`) and the schedule filter its query
    // (`?task=<id>`): closing the drawer is going back to the list, filter kept.
    const { id: selectedId = null } = useParams<{ id?: string }>()
    const acknowledgements = usePersistedStore((state) => state.acknowledgements)
    const [searchParams, setSearchParams] = useSearchParams()
    const search = searchParams.toString() ? `?${searchParams}` : ''
    const open = useCallback(
        (id: string) => navigate({ pathname: `/transfers/${id}`, search }),
        [navigate, search]
    )
    const onClose = useCallback(() => {
        navigate({ pathname: '/transfers', search })
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
    }, [navigate, search, acknowledgements])
    const { rows: allRows, query: transfersQuery } = useTransferRows()

    // A schedule's own runs, when a schedule sent us here (`?task=<id>`). The name is the one
    // the run was recorded under, so a schedule that has since been deleted still reads.
    const taskFilter = searchParams.get('task')
    const transfers = useMemo(() => {
        if (!taskFilter) return allRows
        const ofTask = (row: TransferRow) => row.scheduled?.taskId === taskFilter
        return {
            active: allRows.active.filter(ofTask),
            inactive: allRows.inactive.filter(ofTask),
        }
    }, [allRows, taskFilter])
    const filterLabel = useMemo(
        () =>
            [...transfers.active, ...transfers.inactive].find((row) => row.scheduled?.name)
                ?.scheduled?.name ?? taskFilter,
        [transfers, taskFilter]
    )
    const showEverything = useCallback(
        () => setSearchParams({}, { replace: true }),
        [setSearchParams]
    )
    // The open drawer follows its row: a transfer that ends while it is open stops being live.
    const selected = useMemo(
        () =>
            [...transfers.active, ...transfers.inactive].find((row) => row.id === selectedId) ??
            null,
        [transfers, selectedId]
    )

    // A scheduled run is a transfer like any other now, so it opens where every other one does.
    const handleSelect = useCallback((row: TransferRow) => open(row.id), [open])

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
            <div className="flex flex-col items-center justify-center h-full">
                <Spinner size="lg" />
            </div>
        )
    }

    if (taskFilter && transfers.active.length === 0 && transfers.inactive.length === 0) {
        return (
            <div className="w-full h-full overflow-y-auto">
                <EmptyState
                    icon={ClockIcon}
                    title="This schedule has not run yet"
                    description="Each run shows up here as a transfer, with its progress while it goes and its result after."
                    actions={
                        <Button variant="flat" onPress={showEverything} data-focus-visible="false">
                            Show all transfers
                        </Button>
                    }
                />
            </div>
        )
    }

    if (!allRows || (allRows.active.length === 0 && allRows.inactive.length === 0)) {
        return (
            <div className="w-full h-full overflow-y-auto">
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
            {taskFilter && (
                <div className="flex flex-row items-center gap-3 px-4 py-2 border-b border-divider bg-content1">
                    <ClockIcon className="size-4 shrink-0 text-default-500" />
                    <p className="text-small grow">
                        Runs of <span className="font-medium">{filterLabel}</span>
                    </p>
                    <Button
                        size="sm"
                        variant="light"
                        onPress={showEverything}
                        data-focus-visible="false"
                    >
                        Show all
                    </Button>
                </div>
            )}
            <Tabs
                fullWidth={true}
                size="lg"
                classNames={{
                    // The page is a scrolling sheet, so the tab bar sticks inside it.
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
                    isOpen={true}
                    onClose={onClose}
                    transfer={selected}
                    related={related}
                    onSelectTransfer={open}
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
                    tag === 'schedule' && row.scheduled?.name
                        ? `Run by the schedule “${row.scheduled.name}”.`
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
    const isActive = row.type === 'active'
    // Nothing to measure against until rclone has sized the transfer.
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

                                {row.phase === 'preparing' ? (
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
                                            isStriped={!isIndeterminate}
                                            isIndeterminate={isIndeterminate}
                                        />
                                    </Tooltip>
                                ) : null}
                                {isActive ? (
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
            onPress={onRefresh}
            startContent={
                <RefreshCcwIcon size={28} className={isRefreshing ? 'animate-spin' : ''} />
            }
        />
    )
}
