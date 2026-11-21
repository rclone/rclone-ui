import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Input,
    Skeleton,
    Spinner,
    Tab,
    Tabs,
    Tooltip,
} from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowsRotate as ArrowsRotateIcon,
    Plus as PlusIcon,
    Search as SearchIcon,
} from '@zappicon/react'
import {
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type * as Core from '../../../lib/core/types'
import { formatErrorMessage, onErrorDialog } from '../../../lib/errors'
import { useNow } from '../../../lib/format'
import type { OperationName } from '../../../lib/operations'
import { openWindow, platform } from '../../../lib/shell'
import { useActiveTransfers, useEndedTransfers, useLiveNumbers } from '../../../lib/transfers'
import { matches, newestFirst } from '../../../lib/transfers/ended'
import EmptyState from '../../components/EmptyState'
import { Steps } from '../../components/list/ListWindow'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot } from '../../components/look/Status'
import { WindowHeader } from '../../components/look/WindowHeader'
import { WINDOWS } from '../../routes'
import { byDay, operationLabel } from './describe'
import { EndedRow, RunningCard, toRow } from './rows'
import { endedStateOf, isStatus, readShown, STATUSES, type Status, saveShown } from './shown'

type Transfer = Core.Transfers.Transfer

const LOOK = WINDOWS.history

/** How long the search waits for typing to pause, in ms. */
const SEARCH_PAUSE = 250

/**
 * Returns the transfers that left the running list but may not be in the ended list yet. The
 * two lists are fetched separately after transfers.changed, and either one can return first.
 * Each such transfer is shown as it was last seen running, until the ended list has been
 * fetched again after the transfer left. This way a transfer never disappears for a moment.
 */
function useHandoff(active: Transfer[], ended: Transfer[], endedAt: number): Transfer[] {
    const [seen, setSeen] = useState({
        active,
        leaving: [] as { item: Transfer; leftAt: number }[],
    })
    if (seen.active !== active) {
        const now = new Set(active.map((transfer) => transfer.id))
        const known = new Set(seen.leaving.map((l) => l.item.id))
        const left = seen.active
            .filter((transfer) => !now.has(transfer.id) && !known.has(transfer.id))
            .map((item) => ({ item, leftAt: Date.now() }))
        setSeen({ active, leaving: [...seen.leaving, ...left] })
    }
    return useMemo(() => {
        const running = new Set(active.map((transfer) => transfer.id))
        const held = new Set(ended.map((transfer) => transfer.id))
        return seen.leaving
            .filter((l) => !running.has(l.item.id) && !held.has(l.item.id) && endedAt <= l.leftAt)
            .map((l) => l.item)
    }, [seen.leaving, active, ended, endedAt])
}

/**
 * The list of transfers. The running ones follow transfers.changed, and their numbers update
 * every second. The ended ones load in pages, newest first.
 */
export default function HistoryList({
    onSelect,
    onRetry,
}: {
    onSelect: (id: string) => void
    /** Opens the retry view of a failed transfer. */
    onRetry: (id: string) => void
}) {
    const [initial] = useState(readShown)
    const [status, setStatus] = useState<Status>(initial.status)
    const [search, setSearch] = useState(initial.search)
    // What the lists are asked for: the search once typing pauses.
    const [asked, setAsked] = useState(initial.search.trim())
    useEffect(() => {
        const timer = setTimeout(() => setAsked(search.trim()), SEARCH_PAUSE)
        return () => clearTimeout(timer)
    }, [search])
    useEffect(() => saveShown({ status, search }), [status, search])

    const { transfers: active, query: activeQuery } = useActiveTransfers()
    const ended = useEndedTransfers(
        { state: endedStateOf(status), search: asked },
        status !== 'running'
    )
    const leaving = useHandoff(active, ended.items, ended.updatedAt)
    const progress = useLiveNumbers()
    const now = useNow()
    const runningId = useId()

    // Only the running rows depend on the progress numbers, which change every second. The
    // ended rows are rebuilt only when a list changes, and their rows are memoized, so they
    // don't render again every second.
    const runningRows = useMemo(() => {
        if (status !== 'all' && status !== 'running') return []
        return [...active, ...(status === 'all' ? leaving : [])]
            .filter((transfer) => matches(transfer, asked, operationLabel(transfer.operation)))
            .sort(newestFirst)
            .map((transfer) => toRow(transfer, progress[transfer.id] ?? transfer.live))
    }, [status, active, leaving, asked, progress])
    const endedRows = useMemo(() => {
        if (status === 'running') return []
        const running = new Set(active.map((transfer) => transfer.id))
        return ended.items
            .filter((transfer) => !running.has(transfer.id))
            .map((transfer) => toRow(transfer, undefined))
    }, [status, active, ended.items])

    // Once the list has shown a transfer, it keeps its toolbar. The running and the ended lists
    // answer separately, so a transfer that just ended would otherwise flash the empty state.
    const [shown, setShown] = useState(false)
    if (!shown && (active.length > 0 || ended.items.length > 0)) setShown(true)

    const [refreshing, setRefreshing] = useState(false)
    const { list } = ended
    const refresh = useCallback(async () => {
        setRefreshing(true)
        try {
            // The icon spins until both lists have answered.
            await Promise.all([list.refresh(), activeQuery.refetch()])
        } finally {
            setRefreshing(false)
        }
    }, [list, activeQuery])

    const filtered = status !== 'all' || search.trim() !== ''
    const clear = () => {
        setStatus('all')
        setSearch('')
        setAsked('')
    }

    const nothing = runningRows.length === 0 && endedRows.length === 0
    const error = activeQuery.error ?? ended.error
    const count = active.length

    const header = (
        <WindowHeader
            look={LOOK}
            description={
                <span className="tabular-nums">
                    {count > 0
                        ? plural(count, {
                              one: '# running now. See every transfer with its progress and result.',
                              other: '# running now. See every transfer with its progress and result.',
                          })
                        : t`See your transfers with their progress and result.`}
                </span>
            }
            actions={
                <Tooltip content={t`Refresh`} color="foreground">
                    <Button
                        isIconOnly={true}
                        variant="flat"
                        aria-label={t`Refresh`}
                        onPress={refresh}
                        data-focus-visible="false"
                    >
                        <ArrowsRotateIcon className={cn('size-4', refreshing && 'animate-spin')} />
                    </Button>
                </Tooltip>
            }
        />
    )

    if (!shown && !filtered) {
        // Don't show a list that failed to load as empty.
        if (nothing && error) {
            return (
                <EmptyState
                    icon={LOOK.icon}
                    tone={LOOK.tone}
                    title={t`Couldn't load the transfers`}
                    description={formatErrorMessage(error)}
                    actions={
                        <Button
                            onPress={refresh}
                            isLoading={refreshing}
                            variant="flat"
                            data-focus-visible="false"
                        >
                            <Trans>Retry</Trans>
                        </Button>
                    }
                />
            )
        }
        if (activeQuery.isLoading || !ended.settled) {
            return <HistorySkeleton />
        }
        return (
            <EmptyState
                icon={LOOK.icon}
                tone={LOOK.tone}
                title={t`Nothing has moved yet`}
                description={t`Every operation you start shows up here. Your history stays after a restart.`}
                actions={
                    <>
                        <StartTransfer />
                        <Button
                            variant="flat"
                            startContent={
                                <ArrowsRotateIcon
                                    className={cn('size-4', refreshing && 'animate-spin')}
                                />
                            }
                            onPress={refresh}
                            data-focus-visible="false"
                        >
                            <Trans>Refresh</Trans>
                        </Button>
                    </>
                }
            >
                <Steps steps={STEPS} tone={LOOK.tone} />
            </EmptyState>
        )
    }

    const settling =
        status !== 'running' && (ended.loading || !ended.settled) && endedRows.length === 0
    const tab = STATUSES.find((s) => s.key === status) ?? STATUSES[0]
    return (
        <div className="flex flex-col flex-1 min-h-0">
            <div className="flex flex-col gap-4 px-6 pt-5 pb-4 shrink-0">
                {header}
                <div className="flex flex-wrap items-center gap-3">
                    <Input
                        aria-label={t`Search transfers`}
                        placeholder={t`Search by number, path or error`}
                        value={search}
                        onValueChange={setSearch}
                        isClearable={true}
                        onClear={() => setSearch('')}
                        startContent={<SearchIcon className="size-4 shrink-0 text-default-400" />}
                        className="flex-1 min-w-56 max-w-sm"
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                    />
                    <Tabs
                        aria-label={t({
                            message: 'Status',
                            comment: 'The tabs that show the transfers in one state.',
                        })}
                        size="sm"
                        radius="full"
                        selectedKey={status}
                        onSelectionChange={(key) => isStatus(key) && setStatus(key)}
                        classNames={{ tab: 'h-8 px-3' }}
                    >
                        {STATUSES.map((s) => (
                            <Tab
                                key={s.key}
                                title={
                                    s.key === 'running' && active.length > 0 ? (
                                        <span className="flex items-center gap-1.5">
                                            <StatusDot kind="active" />
                                            {s.label}
                                            <span className="tabular-nums opacity-60">
                                                {active.length}
                                            </span>
                                        </span>
                                    ) : (
                                        s.label
                                    )
                                }
                            />
                        ))}
                    </Tabs>
                </div>
            </div>

            <div className="flex flex-col flex-1 min-h-0 gap-8 px-6 pt-1 pb-10 overflow-y-auto">
                {runningRows.length > 0 && (
                    <section aria-labelledby={runningId} className="flex flex-col gap-3">
                        <SectionTitle
                            id={runningId}
                            title={
                                <span className="flex items-center gap-2">
                                    <Trans>Running now</Trans>
                                    <span className="font-normal tabular-nums text-default-400">
                                        {runningRows.length}
                                    </span>
                                </span>
                            }
                            className="px-1"
                        />
                        <ul className="flex flex-col gap-3">
                            {runningRows.map((row) => (
                                <li key={row.id}>
                                    <RunningCard row={row} onSelect={onSelect} />
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                {activeQuery.isError && (
                    <ListError
                        error={activeQuery.error}
                        retrying={activeQuery.isFetching}
                        onRetry={() => activeQuery.refetch()}
                    />
                )}
                {endedRows.length > 0 && (
                    <section
                        aria-label={t({
                            message: 'Ended',
                            comment: 'The list of the transfers that have ended.',
                        })}
                        className="flex flex-col gap-6"
                    >
                        {byDay(endedRows, now).map(({ day, items }) => (
                            <Day key={day} day={day} count={items.length}>
                                {items.map((row) => (
                                    <li key={row.id}>
                                        <EndedRow row={row} onSelect={onSelect} onRetry={onRetry} />
                                    </li>
                                ))}
                            </Day>
                        ))}
                    </section>
                )}
                {status !== 'running' &&
                    (ended.error && !nothing ? (
                        <ListError
                            error={ended.error}
                            retrying={ended.loading}
                            onRetry={list.retry}
                        />
                    ) : ended.hasOlder && endedRows.length > 0 ? (
                        <LoadOlder loading={ended.loading} onLoad={list.older} />
                    ) : null)}

                {nothing &&
                    (settling ? (
                        <RowsSkeleton />
                    ) : error ? (
                        <ListError
                            error={error}
                            retrying={refreshing}
                            onRetry={() => {
                                refresh()
                            }}
                        />
                    ) : (
                        <EmptyState
                            icon={SearchIcon}
                            tone={LOOK.tone}
                            title={asked ? t`No transfers match` : tab.empty}
                            description={asked ? tab.noMatch(asked) : tab.none}
                            className="flex-1 min-h-0"
                            actions={
                                <Button variant="flat" onPress={clear} data-focus-visible="false">
                                    {asked ? t`Clear search` : t`Show all transfers`}
                                </Button>
                            }
                        />
                    ))}
            </div>
        </div>
    )
}

/** What History is for, under the empty list. */
const STEPS = [
    t`Start a copy, a sync or another operation.`,
    t`Follow its progress here while it runs.`,
    t`Come back to see what moved or failed, and retry.`,
]

const OPERATIONS = [
    'copy',
    'move',
    'sync',
    'bisync',
    'download',
    'delete',
    'purge',
] as const satisfies readonly OperationName[]

function StartTransfer() {
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
            <DropdownTrigger>
                <Button
                    color="primary"
                    className={toneButton(LOOK.tone)}
                    startContent={<PlusIcon className="size-4" />}
                >
                    <Trans>Start a transfer</Trans>
                </Button>
            </DropdownTrigger>
            <DropdownMenu
                aria-label={t`Which operation to start`}
                onAction={(key) => {
                    openWindow(`/${String(key)}`).catch(onErrorDialog(t`Couldn't open the window`))
                }}
            >
                {OPERATIONS.map((operation) => {
                    const look = WINDOWS[operation]
                    return (
                        <DropdownItem
                            key={operation}
                            startContent={<IconTile icon={look.icon} tone={look.tone} size="sm" />}
                        >
                            {look.title}
                        </DropdownItem>
                    )
                })}
            </DropdownMenu>
        </Dropdown>
    )
}

function Day({ day, count, children }: { day: string; count: number; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2.5">
            <h3 className="flex items-baseline gap-2 px-1 text-xs font-semibold tracking-wide uppercase text-default-500">
                {day}
                <span className="font-medium tabular-nums text-default-400">{count}</span>
            </h3>
            <Panel className="overflow-hidden">
                <ul className="flex flex-col divide-y divide-divider">{children}</ul>
            </Panel>
        </div>
    )
}

function RowsSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <Panel className="flex flex-col divide-y divide-divider" aria-busy={true}>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex items-center gap-3.5 py-3.5 pl-4 pr-3">
                    <Skeleton className="rounded-lg size-7" />
                    <div className="flex flex-col flex-1 gap-2">
                        <Skeleton className="w-64 h-3.5 rounded-md" />
                        <Skeleton className="w-40 h-3 rounded-md" />
                    </div>
                    <Skeleton className="w-20 h-3.5 rounded-md" />
                    <Skeleton className="w-10 h-3 rounded-md" />
                </div>
            ))}
        </Panel>
    )
}

function HistorySkeleton() {
    return (
        <div aria-busy={true} aria-label={t`Loading`} className="flex flex-col gap-5 px-6 pt-5">
            <div className="flex items-center gap-3.5">
                <Skeleton className="size-12 rounded-[14px]" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="w-32 h-5 rounded-md" />
                    <Skeleton className="h-3.5 rounded-md w-72" />
                </div>
            </div>
            <div className="flex gap-3">
                <Skeleton className="w-full h-10 max-w-sm rounded-xl" />
                <Skeleton className="h-10 rounded-full w-80" />
            </div>
            <RowsSkeleton />
        </div>
    )
}

function ListError({
    error,
    retrying,
    onRetry,
}: {
    error: unknown
    retrying: boolean
    onRetry: () => void
}) {
    return (
        <div className="flex flex-col items-center gap-3 px-10 py-6 text-center">
            <p className="text-sm text-danger">{formatErrorMessage(error)}</p>
            <Button
                size="sm"
                variant="flat"
                isLoading={retrying}
                onPress={onRetry}
                data-focus-visible="false"
            >
                <Trans>Retry</Trans>
            </Button>
        </div>
    )
}

/** Sits below the ended rows and loads the next older page when it scrolls into view. */
function LoadOlder({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
    const sentinel = useRef<HTMLDivElement>(null)
    // Create one observer for the whole life of the sentinel. A new observer reports the
    // sentinel as visible right away, so creating one on every render (and the page renders on
    // every progress update) would request the page again each time.
    const load = useRef(onLoad)
    useLayoutEffect(() => {
        load.current = onLoad
    })
    useEffect(() => {
        const node = sentinel.current
        if (!node) return
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) load.current()
        })
        observer.observe(node)
        return () => observer.disconnect()
    }, [])
    return (
        <div ref={sentinel} className="flex justify-center py-4">
            {loading ? (
                <Spinner size="sm" />
            ) : (
                <Button size="sm" variant="light" onPress={onLoad} data-focus-visible="false">
                    <Trans>Show older transfers</Trans>
                </Button>
            )}
        </div>
    )
}
